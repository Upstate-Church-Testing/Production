-- Upstate Church campuses, matched to Planning Center (People › Campuses).
-- Safe to run more than once.
insert into public.campuses (name, short_name, code, pco_campus_id, street, city, state, sort_order) values
  ('Anderson Campus',                         'Anderson',        'AND', '67074',  '2620 South Main Street',            'Anderson',     'SC', 1),
  ('Five Forks Campus',                       'Five Forks',      'FF',  '23353',  '11 Five Forks Plaza Ct.',           'Simpsonville', 'SC', 2),
  ('Fountain Inn Campus',                     'Fountain Inn',    'FI',  '92289',  '315 N Main St.',                    'Fountain Inn', 'SC', 3),
  ('Greenville Campus',                       'Greenville',      'GVL', '112654', '2 W Washington Street Suite 200',   'Greenville',   'SC', 4),
  ('Greenville Convention Center (GCC) Campus','GCC',            'GCC', '73221',  '1 Exposition Dr',                   'Greenville',   'SC', 5),
  ('Harrison Bridge Campus',                  'Harrison Bridge', 'HB',  '10656',  '679 N Harrison Bridge Rd',          'Simpsonville', 'SC', 6),
  ('Laurens Campus',                          'Laurens',         'LAU', '89542',  '216 Independence Ave',              'Laurens',      'SC', 7),
  ('Mauldin Campus',                          'Mauldin',         'MAU', '67073',  '509 S Main St',                     'Mauldin',      'SC', 8),
  ('Simpsonville Campus',                     'Simpsonville',    'SVL', '10655',  '3 Hedge St',                        'Simpsonville', 'SC', 9),
  ('Union Gathering',                         'Union',           'UN',  '106452', '405 E Main St.',                    'Union',        'SC', 10)
on conflict (name) do nothing;
