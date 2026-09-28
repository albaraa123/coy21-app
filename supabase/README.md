# Seeding Staff Accounts

1. Create each staff member's auth user via Supabase Studio (Authentication > Add User) or `supabase.auth.admin.createUser`.
2. This auto-creates a `profiles` row via the `handle_new_user` trigger with `role = 'participant'`.
3. Run `seed.sql` (with real emails substituted) against the target database to upgrade their role.
