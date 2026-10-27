import { Context } from "effect";

export class AssetsTag extends Context.Tag("Assets")<AssetsTag, { fetch(request: Request): Promise<Response> }>() {}
