# Accordly — Deployment Guide
**Patent Pending · USPTO Receipt #75170980**

This guide covers deploying:
1. **Website** → Vercel (accordly.app)
2. **API Backend** → Railway (api.accordly.app)
3. **Database** → Railway PostgreSQL (free tier)
4. **Android App** → Google Play Store

---

## PART 1 — WEBSITE → VERCEL

### Prerequisites
- Vercel account at vercel.com (free)
- Domain: accordly.app (purchase at Namecheap ~$12/yr)

### Steps

**1. Install Vercel CLI**
```bash
npm install -g vercel
```

**2. Deploy the website**
```bash
cd accordly-website
vercel deploy --prod
```

**3. Connect your custom domain**
- In Vercel dashboard → Project → Settings → Domains
- Add: `accordly.app` and `www.accordly.app`
- Follow DNS instructions (add CNAME/A records at Namecheap)
- SSL is automatic

**4. Environment variables** (none needed for static site)

That's it. Your website is live at accordly.app. ✅

---

## PART 2 — API BACKEND → RAILWAY

Railway is the fastest path to a production Node.js + PostgreSQL backend.
Free tier: $5/mo credit (covers small apps). Paid: ~$20/mo for production.

### Steps

**1. Create Railway account**
- Go to railway.app → Sign up with GitHub

**2. Create a new project**
- Click "New Project" → "Deploy from GitHub repo"
- Connect your GitHub account
- Push the `accordly-backend` folder to a new GitHub repo first:

```bash
cd accordly-backend
git init
git add .
git commit -m "Initial Accordly API"
# Create repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/accordly-api.git
git push -u origin main
```

**3. Add PostgreSQL**
- In Railway project → "New" → "Database" → "PostgreSQL"
- Railway auto-creates `DATABASE_URL` environment variable ✅

**4. Set environment variables**
In Railway project → Variables, add all variables from `.env.example`:

```
NODE_ENV=production
JWT_SECRET=<generate: openssl rand -hex 32>
JWT_REFRESH_SECRET=<generate: openssl rand -hex 32>
ANTHROPIC_API_KEY=sk-ant-your-key
STRIPE_SECRET_KEY=sk_live_your-key
STRIPE_WEBHOOK_SECRET=whsec_your-webhook
CORS_ORIGINS=https://accordly.app,https://www.accordly.app
```

**5. Run database migrations**
In Railway → your API service → "Shell":
```bash
node src/db/migrate.js
```

**6. Set your API domain**
In Railway → Settings → Domains → Generate domain
Or add custom domain: `api.accordly.app`

**7. Configure Stripe webhook**
- In Stripe Dashboard → Webhooks → Add endpoint
- URL: `https://api.accordly.app/api/v1/webhooks/stripe`
- Events: `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.deleted`
- Copy the webhook secret → add to Railway env as `STRIPE_WEBHOOK_SECRET`

**8. Update website to point to API**
In your app, set the base URL to `https://api.accordly.app/api/v1`

Your API is live. ✅

---

## PART 3 — ANTHROPIC API (Claude Abuse Detection)

**1. Get API key**
- Go to console.anthropic.com
- Create account → API Keys → Create key
- Add to Railway env: `ANTHROPIC_API_KEY=sk-ant-...`

**2. Set spending limit**
- In Anthropic console → Plans → Set monthly limit ($50-100 to start)
- Each abuse detection call costs ~$0.001 (fraction of a cent)
- 100,000 messages analyzed ≈ $100

The AI abuse detection is now live on all Essential+ messages. ✅

---

## PART 4 — STRIPE PAYMENTS

**1. Create Stripe account** at stripe.com

**2. Create products and prices**
In Stripe Dashboard → Products → Create:

| Product | Price | Billing | Price ID |
|---------|-------|---------|----------|
| Accordly Essential | $9.99 | Monthly | Copy → `STRIPE_PRICE_ESSENTIAL_MONTHLY` |
| Accordly Essential | $95.88 | Annual | Copy → `STRIPE_PRICE_ESSENTIAL_ANNUAL` |
| Accordly Safe | $17.00 | Monthly | Copy → `STRIPE_PRICE_SAFE_MONTHLY` |
| Accordly Safe | $156.00 | Annual | Copy → `STRIPE_PRICE_SAFE_ANNUAL` |
| Accordly Pro | $24.00 | Monthly | Copy → `STRIPE_PRICE_PRO_MONTHLY` |
| Accordly Pro | $228.00 | Annual | Copy → `STRIPE_PRICE_PRO_ANNUAL` |
| Attorney Pro | $99.00 | Monthly | Copy → `STRIPE_PRICE_ATTORNEY` |
| Mediator Plan | $149.00 | Monthly | Copy → `STRIPE_PRICE_MEDIATOR` |

**3. Add all price IDs to Railway environment variables**

**4. Test with Stripe test cards**
- Card: `4242 4242 4242 4242` · Any future date · Any CVC

Payments are live. ✅

---

## PART 5 — GOOGLE PLAY STORE

### What you need
- Google Play Developer account: $25 one-time fee at play.google.com/console
- Android Studio (free): developer.android.com/studio
- The backend API running (Part 2 above)

### Option A — React Native (Recommended for Accordly)
React Native lets you build Android (and iOS) from one JavaScript codebase.

**1. Install React Native CLI**
```bash
npm install -g react-native-cli
npx react-native init AccordlyApp --template react-native-template-typescript
cd AccordlyApp
```

**2. Key packages to install**
```bash
npm install @react-navigation/native @react-navigation/stack
npm install axios                    # API calls
npm install @react-native-async-storage/async-storage  # Token storage
npm install react-native-keychain   # Secure credential storage
npm install @notifee/react-native   # Push notifications
npm install react-native-camera     # Document photos
npm install react-native-maps       # Check-in GPS
npm install react-native-biometrics # Fingerprint/face unlock
```

**3. Connect to your API**
Create `src/api/client.js`:
```javascript
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_BASE = 'https://api.accordly.app/api/v1';

const client = axios.create({ baseURL: API_BASE });

client.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('access_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default client;
```

**4. Build the APK for testing**
```bash
cd android
./gradlew assembleRelease
# APK will be at: android/app/build/outputs/apk/release/app-release.apk
```

**5. Generate a signing keystore**
```bash
keytool -genkey -v -keystore accordly-release.keystore \
  -alias accordly -keyalg RSA -keysize 2048 -validity 10000
```
Store this file safely — you need it for every future update.

**6. Build signed AAB for Play Store**
```bash
./gradlew bundleRelease
# AAB at: android/app/build/outputs/bundle/release/app-release.aab
```

**7. Submit to Google Play**
- Go to play.google.com/console
- Create app → Upload AAB
- Complete store listing:
  - App name: Accordly — Co-Parenting, Protected
  - Short description: AI-powered co-parenting compliance and safety platform
  - Full description: (use your website copy)
  - Category: Lifestyle / Family
  - Content rating: Everyone (no mature content)
  - Privacy policy URL: https://accordly.app/privacy
- Submit for review (takes 3-7 days for new apps)

### Option B — Progressive Web App (Faster to launch)
If you want to get to market faster before building native apps:

**1.** Add this to your website `index.html` `<head>`:
```html
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#00c9a7">
```

**2.** Create `manifest.json` in your website root:
```json
{
  "name": "Accordly",
  "short_name": "Accordly",
  "description": "Co-Parenting, Protected.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0b0f14",
  "theme_color": "#00c9a7",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**3.** Users can "Add to Home Screen" on Android — works like a native app immediately.
**4.** Submit the PWA to Google Play using PWABuilder (pwabuilder.com) — free tool that wraps your PWA in an Android shell for Play Store submission.

PWA route: **2-3 days to Play Store** vs React Native: **2-3 weeks**.

---

## QUICK START CHECKLIST

### This week (trademark filed → launch day)
- [ ] Push `accordly-backend` to GitHub
- [ ] Deploy API to Railway (30 min)
- [ ] Run `node src/db/migrate.js`
- [ ] Set all env variables in Railway
- [ ] Deploy `accordly-website` to Vercel (10 min)
- [ ] Connect domain accordly.app to Vercel
- [ ] Create Stripe products and add price IDs
- [ ] Set Stripe webhook endpoint
- [ ] Test: register → login → send message → see AI analysis

### Month 1
- [ ] Create Google Play developer account ($25)
- [ ] Build PWA wrapper with PWABuilder
- [ ] Submit to Play Store
- [ ] Apple Developer account ($99/yr) → App Store submission
- [ ] Send 3 outreach emails (NCJFCJ, AFCC, attorneys)

### Month 2-3
- [ ] Start React Native app for full native experience
- [ ] Add push notifications (Firebase)
- [ ] Add file upload for documents (AWS S3)
- [ ] Add video calling (Daily.co or Twilio — ~$0.004/min)

---

## ESTIMATED MONTHLY COSTS AT LAUNCH

| Service | Cost |
|---------|------|
| Railway (API + PostgreSQL) | $5-20/mo |
| Vercel (website) | Free |
| Anthropic (Claude API) | ~$10-50/mo (usage-based) |
| Stripe | 2.9% + 30¢ per transaction |
| Domain (accordly.app) | ~$1/mo ($12/yr) |
| **Total at launch** | **~$20-75/mo** |

At 100 paying customers ($9.99-24/mo avg), you're cash-flow positive. ✅

---

## SUPPORT

For deployment questions: hello@accordly.app
Patent Pending · USPTO Receipt #75170980
© 2026 Accordly. All rights reserved.
