# Quranic — Quran School Management SaaS

Quranic is a multi-tenant SaaS platform that lets many Quran schools run independently on one application, while the Quranic team manages schools, subscriptions and platform finances from a separate console.

**Stack:** Node.js · Express · MongoDB/Mongoose · EJS · Bootstrap 5 · vanilla JS · Chart.js · PDFKit · ExcelJS · express-session + bcrypt · express-validator

---

## 1. Quick start

```bash
# 1. MongoDB as a replica set (required for financial transactions)
npm run db                                # keep it running; port and replica set come from MONGO_URI

# 2. Install and configure
npm install
cp .env.example .env                      # set SESSION_SECRET at minimum

# 3. Sample data (two schools, plans, staff) and run
npm run seed
npm run dev                               # http://localhost:3000
npm test                                  # uses an in-memory replica set
```

Seeded logins (printed by `npm run seed`):

| Where | Email | Password |
|---|---|---|
| Platform console `/platform/login` | admin@quranic.app (also finance@ / support@quranic.app) | `ChangeMe!2026` |
| School `/login` — Al-Noor Quran Centre (Premium, paid) | admin@alnoor.so · finance@alnoor.so · reception@alnoor.so · teacher@alnoor.so | `School!2026` |
| School `/login` — Darul Huda Madrasa (Standard, trial, payment pending) | admin@darulhuda.so · … | `School!2026` |

For production use `npm run create-superadmin` instead of the seed.

---

## 2. Architecture

```
Browser ──► Express (app.js)
            ├─ helmet (CSP, no inline JS) · compression · rate limits
            ├─ express-session (MongoDB store, httpOnly, sameSite, secure behind HTTPS)
            ├─ tenantContext (AsyncLocalStorage per request)
            ├─ flash · CSRF (synchronizer token)
            ├─ /            routes/public.js    → public site, registration, login
            ├─ /platform    routes/platform.js  → loadPlatformContext → RBAC → platform controllers
            └─ /school      routes/school.js    → loadSchoolContext → subscriptionGate → RBAC → plan features → school controllers
                                    controllers  (HTTP only)
                                    services     (all business logic, transactions, numbering)
                                    models       (Mongoose schemas + tenant plugin)
```

| Folder | Contents |
|---|---|
| `config/` | env config, DB connection + `runInTransaction`, constants, **RBAC matrix** (`roles.js`) |
| `models/` | `platform.js` (PlatformUser, Tenant, SubscriptionPlan, Subscription, SubscriptionPayment, PlatformAuditLog, Counter, Notification), `school.js`, `academic.js`, `finance.js`, `plugins/tenant.js` |
| `services/` | one service per domain: billing, payment, expense, report, subscription, tenant, student, teacher, class, shift, lesson, student lesson, activity, attendance, dashboard, export (PDF/Excel), receipt PDF, notification, audit, job |
| `controllers/` | public, auth, platform, `school/*` |
| `middleware/` | auth/context, CSRF, security headers & rate limits, uploads, validators, flash, errors |
| `views/` | `layouts/` (public, school, platform), `partials/`, one folder per module |
| `public/` | `css/app.css` design system, `js/` (app, charts, payment, invoice picker), images |
| `scripts/` | `seed.js`, `createSuperAdmin.js`, `backup.js` |
| `tests/` | money/numbering units, tenant isolation (data + HTTP), RBAC, billing/payments/reports, subscriptions, Quran school workflow |

---

## 3. Tenant isolation strategy

1. **Every school-owned document carries `tenantId`** (added by `models/plugins/tenant.js`, required and immutable).
2. **The tenant comes only from the server session.** `loadSchoolContext` reads `req.session.auth.tenantId`; any `tenantId` in a form or URL is ignored (covered by a test).
3. **The tenant plugin enforces it on every operation:**
   - queries/updates/deletes/aggregations without a tenant filter are **refused** outside a request;
   - inside a school request they are **auto-scoped** to the signed-in school (this also scopes `populate()`);
   - a filter or new document naming **another** tenant throws `TenantIsolationError`.
4. **Every id received from the browser is resolved with `scope.owned()`** (`findOne({ _id, tenantId })`), so students, classes, invoices, teachers etc. from another school are simply "not found".
5. Unique constraints are tenant-scoped (`{ tenantId, studentCode }`, `{ tenantId, invoiceNo }` …).
6. Platform staff use a **separate session kind and router**; platform statistics only *count* school data (`skipTenant` is explicit and limited to aggregate counts).

---

## 4. Financial design

- **Money is integer minor units (cents)** everywhere — parsed from strings digit-by-digit (`utils/money.js`), validated as safe integers in every schema. No floating-point arithmetic touches a balance.
- **Invoices ≠ income.** `StudentInvoice` records what is owed. Income = confirmed `StudentPayment`s; expenses = recorded `Expense`s; **net = income − expenses**.
- **Duplicate billing is impossible:** live invoices carry `billingKey = student:monthly:YYYY-MM` with a unique partial index; cancelling an invoice removes the key so the period can be re-billed.
- **Payments** are allocated oldest-first (or to selected invoices), overpayment is rejected, and payment + allocations + invoice updates + receipt + audit entry are written in **one MongoDB transaction**.
- **Receipts** are immutable snapshots (school, student, class, category, period, total, paid, remaining balance, method, reference, date, received-by), so reprints always match. Print count is tracked.
- **Nothing confirmed is deleted.** Payments are *reversed*, expenses and salary payments *cancelled*, invoices *cancelled* — each with reason, actor, time and an audit-log entry.
- Teacher salaries create a linked expense in the system category *Teacher salaries*; one live salary payment per teacher per month.
- **Registration fee is one-time.** The school fee is set in *School Settings*; the student registration form charges it (staff with `invoices.manage` may change the amount, e.g. a discount) and can record the payment on the spot with a receipt (`payments.create`). The `student:registration` billing key guarantees one live registration invoice per student.

Reports (HTML, print, PDF, Excel): daily, monthly, annual, student payments, registration fees, outstanding balances, teacher salaries, expenses by category, income & expenditure, net balance (with opening and running balance).

---

## Quran school workflow

- **Registration.** Mother name, district and a photo, taken with the device camera or uploaded. The camera needs HTTPS or localhost; a captured photo goes through the normal upload checks.
- **Categories.** Every student is in one of Farbar, Cashra or Taxfiid (`C.STUDENT_PROGRAMS`). Students registered before categories show *Not set*, can be found with that filter, and must be given one the next time they are edited.
- **Shifts.** Each class has its own shifts (`ClassShift`), managed on the class page. A student is on all of the class's shifts unless some are cleared, and at least one stays selected. A transfer starts from all shifts of the new class. Anyone left without an active shift is placed on all active shifts, so nobody drops off a register. Shifts with attendance are deactivated, not deleted.
- **Attendance.** One register per class, shift and day, so a student can have one record per shift (`{ tenantId, student, date, shift }` is unique; the old index is replaced at startup by `syncIndexes`). A class without shifts keeps one register. Reports count sessions and can be filtered by shift.
- **Student lessons** (`/school/student-lessons`). A student has one open lesson: surah and verses, a juz or a topic. The teacher listens and grades it: Excellent 100%, Very good 85%, Acceptable 70% or Not accepted. Not accepted keeps the same lesson open; every attempt is kept. Scores are in `C.STUDENT_LESSON_GRADES`.
- **Subac.** A session is daily or one-time. A class has at most one daily Subac a day; Beginner-level classes cannot have one, and Farbar students are left out of it. One-time sessions work for any class and student. The score starts at 100 and loses points per error; teachers count errors with − and + or by typing, and can add or remove manual points. The server calculates the score, and absent students have none. School managers set the points in *School Settings → Subac deductions*; each session keeps the points it was created with. Sessions from before this feature keep their typed scores.

---

## Languages

English (default), Arabic (right-to-left) and Somali. The switcher in the top bar, public menu and login page stores the choice in the `quranic.lang` cookie (`GET /lang/:code`).

- `utils/i18n.js` — English text is the key: `t('Students')`, `t('{name} registered as {code}.', { name, code })`; anything untranslated falls back to English. `req.t` in controllers, `t` in views.
- Dictionaries: `locales/<lang>/*.json` (flat `{ "English": "translation" }`, merged per language, loaded at startup — restart after editing).
- `partials/field`, `partials/page-header`, flash messages, `titleCase()` and `statusBadge()` translate automatically. Never name a local variable `t` in a template.
- PDF receipts and PDF/Excel exports are English.

---

## 5. Subscriptions

- Plans (Basic, Standard, Premium, Enterprise are seeded) define price, currency, cycle (monthly / quarterly / six-month / annual / custom days), limits (students, teachers, classes, users; 0 = unlimited), enabled modules, trial, grace period and reminder days.
- A subscription stores a **snapshot of the plan terms**, so editing a plan never silently changes existing contracts.
- Statuses: trial, active, expiring soon, expired, suspended, cancelled. Payment statuses: pending, paid, failed, cancelled, refunded.
- **Only a verified payment activates or extends a subscription** (platform finance verifies in `/platform/payments`). Schools submit payment details from `/school/subscription`; platform staff can also record payments received.
- After expiry the school keeps full access during the grace period, then becomes **read-only** (or blocked, per `EXPIRED_ACCESS_POLICY`). Data is never deleted.
- Limits and module access are enforced **server-side** in services and route middleware.
- A background job (`services/jobService.js`, every `JOB_INTERVAL_MINUTES`) refreshes statuses, sends renewal reminders, marks overdue invoices and posts daily overdue-fee notifications. Platform staff can trigger it from *Subscriptions → Refresh*.
- `SubscriptionPayment.gateway` and `Notification.channels` are reserved for future mobile money / bank / card gateways and email / WhatsApp dispatchers (`notificationService.dispatchers`).

---

## 6. Roles

| School role | Access |
|---|---|
| School Administrator | everything incl. users, settings, subscription, audit log |
| Finance Officer | invoices, billing, payments, reversals, receipts, expenses, salaries, financial reports, subscription payments |
| Teacher | lessons & progress, Subac/Duruus, attendance, academic views (limited to own classes when linked to a teacher profile) |
| Receptionist | register/edit students, receive payments, print receipts, view attendance |

| Platform role | Access |
|---|---|
| Super Admin | everything, staff management, plans, audit log |
| Platform Finance Officer | subscriptions, payment verification, revenue reports |
| Platform Support Officer | schools (view, activate/suspend), subscriptions (view) |

Permissions live in `config/roles.js`; every route declares the permission it needs.

---

## 7. Security checklist

bcrypt (12 rounds) · session regeneration on login (no fixation) · httpOnly/sameSite/secure cookies · CSRF tokens on every form · helmet with strict CSP (no inline scripts) · rate limiting on login/registration/app · express-validator on every form · uploads restricted by MIME, extension, size **and magic bytes**, stored outside `public/` and served only to the owning school · open-redirect protection · audit logs for logins, financial actions, settings and platform operations · tenant isolation tests.

---

## 8. Production deployment

1. MongoDB **replica set or sharded cluster** (transactions are required; keep `MONGO_TRANSACTIONS=true`).
2. `NODE_ENV=production`, a long random `SESSION_SECRET`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` behind a TLS reverse proxy (nginx / load balancer).
3. Run with a process manager (pm2/systemd). With several instances, keep the background job on one (`JOB_INTERVAL_MINUTES=0` on the others).
4. **Backups:** `npm run backup` (mongodump, gzip, rotation via `BACKUP_KEEP_DAYS`) on a daily cron, copied off-site, plus the `uploads/` directory. **Restore:** `mongorestore --uri "$MONGO_URI" --gzip --archive=backups/<file>.gz --drop`. Test restores regularly on a staging database.

---

## 9. Phased development plan (as built)

1. Foundation — config, security middleware, money/date utils, tenant plugin, all models and indexes.
2. Platform — public site, school registration (tenant + admin + settings + subscription in one transaction), plans, subscription lifecycle, payment verification, staff, platform dashboard and reports.
3. School people — dashboard, students (profile, transfer, status, export), teachers, classes (roster, capacity, performance).
4. Learning — Quran lessons with surah/verse ranges and per-student progress, Subac and Duruus, student and teacher attendance with reports.
5. Finance — registration and monthly billing, invoices, payments with allocation, receipts (PDF), expenses (attachments, recurring), salaries, ten financial reports with PDF/Excel.
6. Administration — users & RBAC, settings, numbering formats, notifications, audit logs.
7. Quality — seed data, automated tests (isolation, RBAC, finance, subscriptions), backup tooling.
