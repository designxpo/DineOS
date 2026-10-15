-- Default plan catalogue. Prices in paise per month. Features gate optional modules.
insert into plans (code, name, price_paise, features) values
  ('trial', 'Trial (30 days)', 0, '{"max_outlets": 1, "max_tables": 15, "qr_ordering": true, "kds": true, "print_agent": true, "reports": "basic"}'),
  ('standard', 'Standard', 149900, '{"max_outlets": 1, "max_tables": 40, "qr_ordering": true, "kds": true, "print_agent": true, "reports": "full"}'),
  ('premium', 'Premium', 299900, '{"max_outlets": 5, "max_tables": 100, "qr_ordering": true, "kds": true, "print_agent": true, "reports": "full", "table_vision": false}')
on conflict (code) do nothing;
