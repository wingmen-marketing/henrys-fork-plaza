# Deploying the backend automations (replaces GoHighLevel)

This repo now includes `/functions`, a set of Firebase Cloud Functions that
replace the two GHL workflows the site used to depend on:

- **Update Notifications** → emails `parker@wingmen.marketing`,
  `destinlthayne@gmail.com`, and `fuhriman79@yahoo.com` whenever someone
  requests access, gets approved, posts/replies in the community feed, or
  creates a poll. Fires automatically off Firestore writes — no more client-side
  webhook call to GHL.
- **Stripe Analytics Automation** → keeps each member's `subscriptionStatus`
  in Firestore in sync with their Stripe subscription, via a webhook Stripe
  calls directly.

None of this requires GHL to be running. Everything below is a one-time setup;
after it's deployed once you can cancel your GHL subscription.

## What you'll need

- A Mac terminal (Terminal.app is fine)
- [Node.js](https://nodejs.org) 20 or newer installed
- A free [Resend](https://resend.com) account (for sending the notification emails)
- Access to your Stripe Dashboard

## 1. Get the code

```bash
git clone https://github.com/wingmen-marketing/henrys-fork-plaza.git
cd henrys-fork-plaza
```

(Or download the repo as a ZIP from GitHub and unzip it, then `cd` into the folder.)

## 2. Install the Firebase CLI and log in

```bash
npm install -g firebase-tools
firebase login
```

This opens a browser window — log in with the Google account that owns the
`henry-s-fork-plaza` Firebase project.

## 3. Install the function dependencies

```bash
cd functions
npm install
cd ..
```

## 4. Set up Resend (for sending the notification emails)

1. Go to [resend.com](https://resend.com) and create a free account.
2. In Resend, add `henrysforkplaza.com` as a domain and follow their
   instructions to verify it — they'll give you a few DNS records (TXT/DKIM,
   similar to what we already added for GitHub Pages). Add those in the same
   place: Squarespace → Domains → henrysforkplaza.com → DNS → Custom records.
   Verification usually clears within a few minutes to a few hours.
3. Once verified, create an API key in Resend (Dashboard → API Keys) and copy it.

## 5. Store your secrets

Cloud Functions needs the Resend key and your Stripe secret key. Run each of
these and paste the value when prompted (nothing will echo to the screen):

```bash
firebase functions:secrets:set RESEND_API_KEY
firebase functions:secrets:set STRIPE_SECRET_KEY
```

Get `STRIPE_SECRET_KEY` from Stripe Dashboard → Developers → API keys
("Secret key"). Use your **live** key once you're ready to go live, or the
test key while you're still verifying everything works.

## 6. First deploy

```bash
firebase deploy --only functions
```

This will print a URL for the `stripeWebhook` function that looks like:

```
https://stripewebhook-xxxxxxxxxx-uc.a.run.app
```

Copy that URL — you need it in the next step.

## 7. Point Stripe at the new webhook

1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**.
2. Paste the `stripeWebhook` URL from step 6.
3. Select these events: `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
4. Save, then copy the **Signing secret** Stripe shows you (starts with `whsec_`).
5. Store it:
   ```bash
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
   ```
6. Redeploy so the function picks up the new secret:
   ```bash
   firebase deploy --only functions
   ```

## 8. Test it

- Sign up for a test account on the live site (or have someone else do it) —
  all three of you should get a "New account request" email within a few seconds.
- Post a test discussion topic, reply to it, and create a test poll — each
  should trigger its own email.
- In Stripe Dashboard → Webhooks → your new endpoint, use **Send test webhook**
  to fire a `checkout.session.completed` event and confirm it returns a
  `200` response (check the endpoint's "Recent deliveries" log).

## 9. Once you're confident it's working

- Cancel your GoHighLevel subscription.
- (Optional cleanup) In GHL, before cancelling, you can disable/delete the
  "Update Notifications" and "Stripe Analytics Automation" workflows — they'll
  no longer receive any traffic once GHL is cancelled anyway, since the site
  no longer calls out to GHL for anything.

## Making changes later

Everything lives in `functions/index.js`. Edit it, then redeploy with:

```bash
firebase deploy --only functions
```

To change who gets notified, edit the `NOTIFY_EMAILS` list near the top of
that file.
