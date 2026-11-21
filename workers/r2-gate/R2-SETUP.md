# R2 setup — exact steps for the owner (Zouhair)

Everything in `workers/r2-gate/` (Worker code, tests, player page,
upload helper) is already built and tested locally. **Nothing is
deployed and no cloud account exists yet.** The steps below are the
only things that need his clicks — in this order. Estimated time:
30–45 minutes + waiting for the video upload.

> Use **zouhair.secret@gmail.com** for the Cloudflare account (same
> rule as the other projects: Bayt + personal work always on that
> account). Do **not** create the account with another email.

## Step 1 — Create the Cloudflare account

1. Go to https://dash.cloudflare.com/sign-up
2. Sign up with **zouhair.secret@gmail.com** (a password he chooses,
   or "Continue with Google" with that same account).
3. Verify the email Cloudflare sends.
4. Turn on two-factor authentication (My Profile → Authentication →
   Two-Factor Authentication). The account will hold the videos:
   protect it like the Firebase project.

## Step 2 — Add a payment method (enables R2)

R2 requires a payment method on file to enable — even for free use.

1. Dashboard → Billing → Payment methods → Add payment method.
2. Add a card (CIH card is fine). **Nothing is charged at this
   point:** the free tier (below) covers the launch, and R2 has no
   egress fees at all, so the bill stays $0 until storage or
   operations grow past the free tier.
3. Then go to R2 (left menu) and click "Enable R2" / accept the
   terms if asked.

## Step 3 — Create the bucket

1. Dashboard → R2 → Create bucket.
2. Name: **`mahrez-courses`** (exactly this — the Worker and the
   upload helper already use it).
3. Location: Automatic (default). Leave "Public access" **OFF** —
   the bucket must stay private; the Worker is the only door in.
4. Create.

## Step 4 — Create an R2 API token (S3-compatible)

1. Dashboard → R2 → Manage R2 API Tokens → Create API token.
2. Permissions: **Object Read & Write** (the Worker only reads via
   presigned URLs, but the upload helper writes with the same token).
   Apply to: the `mahrez-courses` bucket only (not "all buckets").
3. Copy the **Access Key ID** and the **Secret Access Key** that
   appear once. The secret is shown **only once** — save it somewhere
   safe (password manager / USB, never in chat or email).
4. The account ID is on the R2 overview page (right side, "Account
   ID") — copy it too.

## Step 5 — Set the Worker secrets

> The Worker reads Firestore **as the learner**, with the learner's
> own verified Firebase ID token — so Firestore rules (v4.3) enforce
> ownership: a learner can only read their own enrollment docs.
> There is **no service account and no master key** anywhere in this
> setup — nothing to generate, nothing to keep offline, nothing that
> could leak and open the whole project.

On the machine with the repo (Muse does this part, or Zouhair in a
terminal with wrangler installed):

```bash
cd preview/workers/r2-gate
wrangler login                                   # signs in as zouhair.secret@gmail.com
wrangler secret put R2_ACCOUNT_ID                # paste the Account ID from step 4
wrangler secret put R2_ACCESS_KEY_ID             # paste the Access Key ID
wrangler secret put R2_SECRET_ACCESS_KEY         # paste the Secret Access Key
```

## Step 6 — Deploy the Worker

```bash
cd preview/workers/r2-gate
wrangler deploy
# → https://mahrez-courses-gate.<subdomain>.workers.dev
```

Copy that URL into `preview/video-test.html` — the single
`WORKER_URL` constant at the top of its script — and test with the
sample clip (step 7).

## Step 7 — Upload the first video (test, then real)

```bash
export R2_ACCOUNT_ID=...            # same values as step 4
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET=mahrez-courses

# Test clip (10 s, generated locally — NOT a real lesson):
node preview/scripts/r2-upload.mjs preview/workers/r2-gate/test-clip.mp4 hijama 0.1

# A real lesson, once filmed and compressed to 720p:
node preview/scripts/r2-upload.mjs /path/to/lesson-0.1.mp4 hijama 0.1
# → stored as courses/hijama/0.1.mp4
```

Then open `video-test.html`, sign in, pick hijama / lesson 0.1 and
press play. Lesson 0.1 is a **free** preview lesson, so it plays
even without an approved enrollment (a signed-in learner is still
required for paid lessons).

## Costs (Cloudflare R2, as of Nov 2026)

| Item | Free tier (per month) | Over the free tier |
|---|---|---|
| Storage | 10 GB | $0.015 / GB / month |
| Class A operations (writes, lists) | 1,000,000 | $4.50 / million |
| Class B operations (reads) | 10,000,000 | $0.36 / million |
| Egress (data out to learners) | **$0 — always** | $0 |

What that means for us:

- Hijama course, ~7 h at 720p ≈ **5–8 GB** → inside the free tier.
- 3 courses ≈ 15–24 GB → about **$0.08–$0.21 / month** of storage
  above the free 10 GB.
- Learners watching videos are Class B reads: 10 M free reads is
  far above a few thousand learners (each lesson view is a handful
  of reads, even with seeking).
- **Realistic total at launch: $0 / month. With 3 courses live and
  thousands of learners: roughly $0–5 / month.**

## Honest security notes (read before promising anything)

- **Screen recording cannot be stopped** — by anyone, anywhere,
  including Netflix and Bunny. A learner can always record their
  screen. No platform prevents that.
- What this setup **does** stop: direct links to the videos (the
  bucket is private, there is no public URL), downloading via the
  player (no download button, right-click blocked, expiring links),
  hot-linking from other sites (domain lock), and sharing a link
  (it dies after 10 minutes). Those are strong deterrents, not a
  guarantee.
- The **real** protection against re-uploading is the one Zouhair
  already decided: **he burns his watermark into the filmed videos
  himself** (learner name/email on screen). A re-uploaded video
  still carries the leaker's name.
- The signed URL is visible in the browser's network tab to a
  determined user — that is true of every streaming service. The
  10-minute expiry limits what can be done with it.
- Keep the R2 secret key (step 4) offline. Anyone holding it can
  read the bucket. If it ever leaks, revoke it immediately (delete
  the token in the dashboard and create a new one) and re-run
  step 5. There is no Firebase master key in this setup at all —
  the Worker only ever reads Firestore as the signed-in learner.
