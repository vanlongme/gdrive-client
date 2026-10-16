import { createApp } from "./app";

export { ProjectCoordinator } from "./objects/project-coordinator";
export { UploadSession } from "./objects/upload-session";

const app = createApp();

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
