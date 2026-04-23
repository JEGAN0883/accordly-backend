/**
 * Accordly AI Abuse Detection Service
 * Patent Pending — USPTO #75170980
 * 
 * Uses Claude claude-sonnet-4-20250514 to analyze messages for:
 * - Threatening language
 * - Coercive control
 * - Parental alienation
 * - Financial abuse
 * - Harassment patterns
 * - Emotional manipulation
 * - Child triangulation
 * - Surveillance demands
 * - Isolation attempts
 * - Gaslighting indicators
 * - Safety threats
 * - Plan violations
 */

const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ABUSE_CATEGORIES = [
  'threatening_language',
  'coercive_control', 
  'parental_alienation',
  'financial_abuse',
  'harassment',
  'emotional_manipulation',
  'child_triangulation',
  'surveillance_demand',
  'isolation_attempt',
  'gaslighting',
  'safety_threat',
  'plan_violation'
];

/**
 * Analyze a message for abuse patterns before sending
 * @param {string} messageContent - The message to analyze
 * @param {Object} context - Additional context (relationship history, plan provisions)
 * @returns {Object} Analysis result with threat level, categories, and recommendations
 */
const analyzeMessage = async (messageContent, context = {}) => {
  try {
    const prompt = `You are Accordly's AI safety system for co-parenting communications. Your role is to protect families by detecting abuse patterns in messages BEFORE they are sent.

Analyze the following message for co-parenting communication:

MESSAGE TO ANALYZE:
"${messageContent}"

CONTEXT:
${context.recentFlags ? `Recent flags (last 30 days): ${JSON.stringify(context.recentFlags)}` : 'No recent flags'}
${context.planProvisions ? `Parenting plan provisions: ${context.planProvisions}` : ''}

Analyze for these 12 categories:
1. threatening_language - Explicit or implied threats of harm, legal action used as threat, threats regarding children
2. coercive_control - Demands beyond court order scope, surveillance requests, control tactics
3. parental_alienation - Attempts to turn children against the other parent, speaking negatively about co-parent
4. financial_abuse - Unauthorized financial demands, withholding financial information, support manipulation
5. harassment - Repeated unwanted contact, stalking behavior, intimidation
6. emotional_manipulation - Guilt-tripping, gaslighting language, emotional coercion
7. child_triangulation - Using children as messengers, interrogating through children
8. surveillance_demand - Demanding personal schedules, location tracking beyond plan scope
9. isolation_attempt - Attempting to cut off support networks
10. gaslighting - Denying documented events, reality distortion
11. safety_threat - Any threat to physical safety of parent or children
12. plan_violation - Explicit violation or threat to violate court order provisions

Respond in this EXACT JSON format (no other text):
{
  "threat_level": "none|low|medium|high|critical",
  "should_block": false,
  "categories": [],
  "analysis": "Brief explanation of what was detected (1-2 sentences, factual)",
  "compliance_guidance": "What the receiving party's rights are in this situation (1-2 sentences)",
  "suggested_rewrite": "A neutral, compliant alternative message if needed (null if message is fine)",
  "legal_note": "Specific plan provision or legal right implicated (null if N/A)",
  "escalation_recommended": false
}

IMPORTANT: 
- Be precise. Do not flag normal co-parenting frustration as abuse.
- DO flag language that: threatens consequences to the other parent's parental relationship, makes demands outside the parenting plan, uses children as weapons.
- threat_level "critical" = immediate safety concern or explicit threat
- threat_level "high" = clear abuse pattern or severe plan violation  
- threat_level "medium" = concerning pattern that needs documentation
- threat_level "low" = elevated tone, mild concern
- threat_level "none" = no concern detected`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    
    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI returned non-JSON response');
    
    const result = JSON.parse(jsonMatch[0]);
    
    // Validate and sanitize
    return {
      threat_level: VALID_LEVELS.includes(result.threat_level) ? result.threat_level : 'none',
      should_block: Boolean(result.should_block),
      categories: (result.categories || []).filter(c => ABUSE_CATEGORIES.includes(c)),
      analysis: String(result.analysis || ''),
      compliance_guidance: String(result.compliance_guidance || ''),
      suggested_rewrite: result.suggested_rewrite || null,
      legal_note: result.legal_note || null,
      escalation_recommended: Boolean(result.escalation_recommended),
    };

  } catch (err) {
    logger.error('AI analysis error:', err.message);
    // Fail open — don't block messages if AI fails
    return {
      threat_level: 'none',
      should_block: false,
      categories: [],
      analysis: 'AI analysis unavailable',
      compliance_guidance: '',
      suggested_rewrite: null,
      legal_note: null,
      escalation_recommended: false,
      ai_error: true,
    };
  }
};

const VALID_LEVELS = ['none', 'low', 'medium', 'high', 'critical'];

/**
 * Analyze a 30-day pattern for escalation recommendations
 */
const analyzePattern = async (messages, relationshipContext = {}) => {
  try {
    const flaggedMessages = messages.filter(m => m.ai_threat_level && m.ai_threat_level !== 'none');
    if (flaggedMessages.length < 2) return { pattern_detected: false };

    const summary = flaggedMessages.map(m => ({
      date: m.created_at,
      level: m.ai_threat_level,
      categories: m.ai_categories,
    }));

    const prompt = `You are Accordly's pattern analysis system. Analyze the following message flag history for escalation patterns.

FLAGS IN LAST 30 DAYS:
${JSON.stringify(summary, null, 2)}

Identify:
1. Is there an escalating pattern (frequency or severity increasing)?
2. What is the dominant abuse category?
3. Does this meet the threshold for attorney notification or court action?

Respond in EXACT JSON:
{
  "pattern_detected": true,
  "pattern_type": "escalating|stable|de-escalating",
  "dominant_category": "category_name",
  "court_ready": false,
  "attorney_notification_recommended": false,
  "summary": "One sentence describing the pattern"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in pattern response');
    
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.error('Pattern analysis error:', err.message);
    return { pattern_detected: false };
  }
};

/**
 * Generate AI narrative for court report
 */
const generateCaseNarrative = async (caseData) => {
  try {
    const prompt = `You are Accordly's court report generation system. Generate a factual, objective case narrative for legal proceedings.

CASE DATA:
Parent A (Filing Parent): ${caseData.parentA}
Parent B (Co-Parent): ${caseData.parentB}
Period: ${caseData.period}
Parent A Fitness Score: ${caseData.scoreA}/100
Parent B Fitness Score: ${caseData.scoreB}/100

COMPLIANCE DATA:
- Visit completion rate (Parent B): ${caseData.visitRate}%
- Payment compliance: ${caseData.paymentStatus}
- Communication flags: ${caseData.flagCount} in period
- Plan violations: ${caseData.violationCount}
- Child wellness trends: ${caseData.wellnessTrend}

Generate a 2-3 paragraph neutral, factual narrative suitable for court submission.
State only documented facts. Do not use emotional language.
End with a compliance summary sentence.

IMPORTANT: Include the following disclosure: "This narrative was generated with AI assistance from Accordly. All data is derived from timestamped platform records. Admissibility is subject to applicable rules of evidence."`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0].text.trim();
  } catch (err) {
    logger.error('Narrative generation error:', err.message);
    return 'AI narrative generation unavailable. Please review the data tables above.';
  }
};

module.exports = { analyzeMessage, analyzePattern, generateCaseNarrative };
