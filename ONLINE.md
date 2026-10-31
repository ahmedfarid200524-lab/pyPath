# Put pyPath online (Vercel + Neon, free)

You need two free accounts: **Neon** (database) and **Vercel** (website). Takes about 15 minutes.
Your laptop does not need to stay on after this.

## 1. Create the database (Neon)
1. Go to **neon.tech** and sign up (free).
2. Create a project (any name, pick the region closest to your users).
3. On the project page click **Connect** and copy the **connection string**. It looks like
   `postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require`. Keep it secret.

The tables are created automatically the first time the site runs.

## 2. Make your secret values
Open a terminal in the project folder and run this once to make a long random secret:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy the result. This is your `TOKEN_SECRET`.

## 3. Deploy to Vercel (from your laptop, no GitHub needed)
1. Unzip the project. The folder must contain `index.html`, `admin.html`, `api`, `lib`, `package.json`, `vercel.json`.
2. In a terminal inside that folder:
   ```
   npm install -g vercel
   vercel login
   vercel
   ```
   Answer the questions: set up and deploy **Y**, scope = your account, link to existing project **N**,
   project name `pypath`, directory `./`, and press Enter for the rest (no build settings needed).
3. Add your settings (one command each; paste the value when asked, choose Production, Preview and Development):
   ```
   vercel env add DATABASE_URL
   vercel env add TOKEN_SECRET
   vercel env add ADMIN_PASSWORD
   ```
   For emails also add: `ADMIN_EMAIL`, `SMTP_HOST` (smtp.gmail.com), `SMTP_PORT` (465), `SMTP_SECURE` (true),
   `SMTP_USER`, `SMTP_PASS` (your Gmail app password), `MAIL_FROM` (your Gmail address).
   You can also add them on vercel.com: Project, Settings, Environment Variables.
4. Deploy for real:
   ```
   vercel --prod
   ```
5. Open `https://YOUR-SITE.vercel.app/api/health`. You should see `{"ok":true}`. Then open the site itself.
   If you see an error message about a missing setting, add that variable and run `vercel --prod` again.

The admin page is `https://YOUR-SITE.vercel.app/admin`. The links in approval emails use your site address automatically.

## 4. Bring your existing users (optional)
To move the accounts and progress from your laptop server into the online database:
```
npm install
set DATABASE_URL=postgresql://...your neon string...
node scripts/import-db.js server\data\db.json
```
(On Mac/Linux use `export DATABASE_URL=...` and `server/data/db.json`.) It is safe to run twice.
Everyone logs in with the same email and password as before, and their progress is kept.

## 5. Updating later
Change files, then run `vercel --prod` again. The data stays in Neon.

## Good to know
- **HTTPS is automatic**, so passwords are encrypted in transit.
- **Never share** the Neon string, `TOKEN_SECRET`, `ADMIN_PASSWORD` or the Gmail app password, and never upload a `.env` file.
- **Backups:** Neon keeps a short history on the free plan. For important data, export it now and then
  (Neon dashboard, SQL editor: `select * from users`).
- **Free limits:** Vercel and Neon free plans have monthly limits. Hundreds of people is fine. Many people
  playing battles at the same time uses the most (the app checks the server every couple of seconds).
- **Not built yet:** password reset.
- The old laptop server (`server` folder) still works on its own and is not used online.
