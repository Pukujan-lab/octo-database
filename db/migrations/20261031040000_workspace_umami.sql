-- Octo Schema: a workspace's Umami team and website (#400)
--
-- UX analytics (clicks, replays, heatmaps) run in a separate self-hosted Umami.
-- Turning it on for a workspace creates a Umami team and website through Umami's
-- API; Octo keeps their ids here. The website id is the tracking key apps embed.

ALTER TABLE octo.workspaces
    ADD COLUMN IF NOT EXISTS umami_team_id UUID,
    ADD COLUMN IF NOT EXISTS umami_website_id UUID;
