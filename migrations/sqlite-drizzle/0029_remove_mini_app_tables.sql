-- Mini-apps feature removal: the guest-app runtime (install, grants, sandbox
-- files, logos) is gone. The tables have no readers left, so drop them;
-- stored app data is intentionally discarded. Child tables drop before
-- mini_app: their sourceId foreign keys reference mini_app.appId.
DROP TABLE `mini_app_file_ref`;--> statement-breakpoint
DROP TABLE `mini_app_logo_file_ref`;--> statement-breakpoint
DROP TABLE `mini_app_grant`;--> statement-breakpoint
DROP TABLE `mini_app_installation`;--> statement-breakpoint
DROP TABLE `mini_app`;