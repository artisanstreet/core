import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { router as meta_router } from "../handlers/meta.ts";
import { router as magic_router } from "../handlers/auth/magic.ts";
import { router as totp_router } from "../handlers/auth/totp.ts";
import { router as sessions_router } from "../handlers/auth/sessions.ts";
import { router as machines_router } from "../handlers/machines.ts";
import { router as grants_router } from "../handlers/grants.ts";
import { router as vault_router } from "../products/editor/handlers/vault.ts";
import { router as artifacts_router } from "../products/editor/handlers/artifacts.ts";
import { router as config_router } from "../products/editor/handlers/config.ts";
import { router as account_router } from "../handlers/account.ts";
import { router as ui_router } from "../handlers/ui.ts";
import { router as portal_router } from "../handlers/portal.ts";

export const base_router = HttpRouter.empty.pipe(
  HttpRouter.concat(meta_router),
  HttpRouter.concat(magic_router),
  HttpRouter.concat(totp_router),
  HttpRouter.concat(sessions_router),
  HttpRouter.concat(machines_router),
  HttpRouter.concat(grants_router),
  HttpRouter.concat(vault_router),
  HttpRouter.concat(artifacts_router),
  HttpRouter.concat(config_router),
  HttpRouter.concat(account_router),
  HttpRouter.concat(ui_router),
  HttpRouter.concat(portal_router),
);

export const compiled_app = Effect.runSync(HttpRouter.toHttpApp(base_router));
