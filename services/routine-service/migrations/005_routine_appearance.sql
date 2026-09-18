-- How a routine looks in the client: a symbol and a colour chosen by the user.
-- NULL means "not chosen" – the client then derives both from the first action.
ALTER TABLE routines ADD COLUMN icon text;
ALTER TABLE routines ADD COLUMN color text;
