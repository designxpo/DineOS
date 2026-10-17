-- A restaurant's own look (white label for its staff and guests, not for resale): its logo, cover
-- photo, colour and heading style on the staff portal, QR menu, order tracking and pickup screen.
-- Paid plans include it; the trial shows the DineOS look. What the owner sets is kept either way,
-- so it goes live the moment the plan allows it.
update plans set features = features || '{"white_label": true}'::jsonb where code in ('standard', 'premium');
update plans set features = features || '{"white_label": false}'::jsonb where code = 'trial';

-- DineOS can switch it on or off for one restaurant (a deal, or a brand that breaks the rules).
-- Null follows the plan. Only DineOS admins change it; the app may read it.
alter table tenants add column white_label boolean;
