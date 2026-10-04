# Arabic Encyclopedia — Version 3 (Supabase Sync)

This version keeps your GitHub Pages site and adds optional cross-device progress syncing.

## Files to upload to GitHub
- index.html
- style.css
- script.js
- vocab.json
- config.js

You can also keep README.md and supabase-setup.sql in the repository.

## Supabase setup
1. Open your Supabase project.
2. Go to SQL Editor.
3. Open `supabase-setup.sql`, copy all of it, paste it into the SQL Editor, and run it.
4. In Supabase, find your Project URL and the browser-safe publishable key (or legacy anon key).
5. Open `config.js` and replace the two placeholders.
6. Do NOT use the service_role key.
7. In Authentication URL configuration, set your Site URL to your GitHub Pages URL.
8. Add the same GitHub Pages URL to Redirect URLs.

Example:
https://YOUR-GITHUB-USERNAME.github.io/arabic-encyclopedia/

## How sync works
- Not signed in: progress still saves to localStorage on that device.
- Signed in: progress is also saved in Supabase.
- Sign into the same account on another device to load the synced progress.

## Security
The progress table uses Row Level Security so authenticated users can only read and change their own rows.
