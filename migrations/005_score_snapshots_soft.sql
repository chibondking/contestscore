-- Which logger sent each Score broadcast (<soft> in dynamicresults, e.g.
-- "DXLog"). DXLog sends Score on its online-scoreboard timer rather than
-- per QSO, so the dashboard flags its score as delayed and shows the
-- measured reporting interval. Nullable ADD COLUMN, same as 004.
ALTER TABLE score_snapshots ADD COLUMN soft TEXT DEFAULT '';
