# Hands for Humankind Volunteer Hub

Volunteer sign-ups, username-only accounts, and hour tracking for H4H.

## Run it
1. Install Node 18 or newer (nodejs.org).
2. In this folder, run:
   - Mac/Linux: `ADMIN_CODE=pick-a-secret node server.js`
   - Windows PowerShell: `$env:ADMIN_CODE="pick-a-secret"; node server.js`
3. Open http://localhost:3000

No `npm install` needed. Data is saved in `data.json` (created on first run with 3 sample events).

## How it works
- **Events page**: anyone can browse. Signing up asks for a username.
- **Accounts**: username only. A new username creates an account, an existing one logs in.
- **Dashboard**: Overview (hours, joined, upcoming, waitlisted), My Activities, Update Profile.
- **Waitlist**: when an event is full, new sign-ups join the waitlist. If someone cancels, the next person moves up.
- **Hours**: an event's length counts toward a volunteer's hours once its end time has passed.
- **Admin** (`#/admin`): enter the admin code to add or delete events, view rosters, and see every volunteer's hours.

## Putting it online
Host the folder on any Node host (Render, Railway, Fly.io). Set `ADMIN_CODE` there. Keep `data.json` on a persistent disk, or it resets on redeploy.

## Known limits
- Username-only means anyone who knows a username can log in as that person. Fine for a club, but don't store private info.
- Event times use the server's time zone.
