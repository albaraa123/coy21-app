-- diag_lpad_behavior.sql
-- DIAGNOSTIC ONLY, part of the P0 next_application_number() investigation.
-- Tests lpad()'s real truncation behavior directly, since layer 2's results
-- showed 6-digit sequence values appearing as 5-digit strings in the
-- function's output -- checking whether lpad(text, 5, '0') on an
-- already-6-character string truncates (Postgres docs say it does, from
-- the LEFT, when the target length is shorter than the input -- this
-- contradicts the assumption embedded in next_application_number()'s
-- original design/comment that lpad only pads).
insert into diag_app_number_log (layer, call_index, value)
values
  ('layer_lpad_probe', 1, lpad('165750', 5, '0')),
  ('layer_lpad_probe', 2, lpad('165759', 5, '0')),
  ('layer_lpad_probe', 3, lpad('99999', 5, '0')),
  ('layer_lpad_probe', 4, lpad('100000', 5, '0')),
  ('layer_lpad_probe', 5, lpad('1', 5, '0'));
