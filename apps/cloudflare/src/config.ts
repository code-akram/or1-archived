export type Membership = "owner" | "viewer";
export type ProjectConfig = {
  projectId: string;
  label: string;
  refs: string[];
  members: { email: string; membership: Membership }[];
};
export type Config = { defaultProjectId: string; projects: ProjectConfig[] };
export type Env = {
  PUBLIC_ORIGIN: string;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
  PROJECT_CONFIG: string;
  PROVISIONER_ENABLED?: string;
  PROJECTS: DurableObjectNamespace;
  ASSETS: Fetcher;
};

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) throw new Error("Invalid origin");
  return value;
}

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

/** Configuration is deployment-owned, bounded, and never supplied by a browser. */
export function configuration(env: Env): Config {
  origin(env.PUBLIC_ORIGIN);
  origin(env.ACCESS_ISSUER);
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER))
    throw new Error("Invalid Access issuer");
  if (!env.ACCESS_AUD || env.ACCESS_AUD.length > 256) throw new Error("Invalid audience");
  if (env.PROJECT_CONFIG.length > 32_768) throw new Error("Configuration too large");
  const value = JSON.parse(env.PROJECT_CONFIG) as Config;
  if (
    !value ||
    !identifier(value.defaultProjectId) ||
    !Array.isArray(value.projects) ||
    value.projects.length < 1 ||
    value.projects.length > 16
  )
    throw new Error("Invalid projects");
  const ids = new Set<string>();
  for (const project of value.projects) {
    if (
      !project ||
      !identifier(project.projectId) ||
      ids.has(project.projectId) ||
      typeof project.label !== "string" ||
      !project.label.length ||
      project.label.length > 128 ||
      !Array.isArray(project.refs) ||
      project.refs.length > 32 ||
      project.refs.some((ref) => !identifier(ref) || ref === "main") ||
      new Set(project.refs).size !== project.refs.length ||
      !Array.isArray(project.members) ||
      project.members.length > 64
    )
      throw new Error("Invalid project");
    ids.add(project.projectId);
    const emails = new Set<string>();
    for (const member of project.members) {
      if (
        !member ||
        typeof member.email !== "string" ||
        member.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+$/.test(member.email) ||
        emails.has(member.email) ||
        !["owner", "viewer"].includes(member.membership)
      )
        throw new Error("Invalid membership");
      emails.add(member.email);
    }
  }
  if (!ids.has(value.defaultProjectId)) throw new Error("Invalid default project");
  return value;
}
