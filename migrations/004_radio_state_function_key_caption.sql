-- Surface N1MM's FunctionKeyCaption (RadioInfo) on the dashboard: the label
-- of the function key that started the current transmission (e.g. "F1: CQ"),
-- confirmed against n1mmwp.hamdocs.com's RadioInfo example. Adding a
-- nullable column, no constraint change -- plain ADD COLUMN is enough,
-- unlike 001/002/003's table recreates.
ALTER TABLE radio_state ADD COLUMN function_key_caption TEXT DEFAULT '';
