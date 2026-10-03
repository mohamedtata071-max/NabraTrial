# NABRA deployment checklist

1. Push this folder to GitHub.
2. Create a Railway service from the repository.
3. Add a PostgreSQL/Neon `DATABASE_URL`.
4. Set a long random `SESSION_SECRET`.
5. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
6. Deploy and verify `/health`.
7. Verify `/`, `/login`, `/signup`.
8. Create a test customer account.
9. Confirm first login goes to `/setup`.
10. Create an agent, log out, log back in, and confirm `/app`.
11. Confirm `/admin` only works for the admin account.
12. Set `SITE_URL` to the final public HTTPS domain.
13. Add Vapi/Paymob/email/Google variables only when those integrations are ready.
