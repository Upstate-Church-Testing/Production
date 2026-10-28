-- =============================================================================
-- Open positions: gear we know is there before we know what model it is.
-- A placeholder model has unknown = true (usually named for its category,
-- like "Projector"). Its items show "Model unknown" until someone finds out
-- what they are and switches them to the real model.
-- =============================================================================

alter table public.device_types add column unknown boolean not null default false;
comment on column public.device_types.unknown is 'Placeholder: the model isn''t known yet. Items on it still need identifying.';
