import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ArtefactInfo,
  ProjectSummary,
  UpdateProjectRequest,
} from "../shared/protocol";
import { HttpError, type Publish, userTopic } from "./chats";
import type { Db, ProjectRow } from "./db";
import { ARTEFACTS_LINK } from "./pi";

const NAME_LENGTH = 120;
/** Artefacts listed by name in the system prompt. Pi can list the folder for the rest. */
const PROMPT_ARTEFACTS = 200;

export interface ProjectServiceOptions {
  db: Db;
  dataDir: string;
  publish: Publish;
}

/**
 * Projects and their artefacts. Artefacts are plain files in one folder per project, which is the
 * only record of them. Chats see that folder through a symlink in their own folder; the files are
 * read-only so Pi's edit and write tools can't change them, and Pi is told to leave them alone.
 */
export class ProjectService {
  constructor(private options: ProjectServiceOptions) {
    // Uploads that were cut off by a crash.
    rmSync(this.tmpDir(), { recursive: true, force: true });
  }

  listProjects(userId: string): ProjectSummary[] {
    return this.options.db
      .listProjects(userId)
      .map((project) => this.summary(project))
      .sort((a, b) => compareNames(a.name, b.name));
  }

  createProject(
    userId: string,
    name: string,
    instructions: string,
  ): ProjectSummary {
    const now = Date.now();
    const project: ProjectRow = {
      id: randomUUID(),
      userId,
      name: projectName(name),
      instructions: instructions.trim(),
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.options.db.insertProject(project);
    return this.publish(project);
  }

  updateProject(
    userId: string,
    projectId: string,
    update: UpdateProjectRequest,
  ): ProjectSummary {
    const project = this.getProject(userId, projectId);
    const updated: ProjectRow = { ...project, updatedAt: Date.now() };
    if (update.name !== undefined) updated.name = projectName(update.name);
    if (update.instructions !== undefined)
      updated.instructions = update.instructions.trim();
    if (update.archived !== undefined)
      updated.archivedAt = update.archived
        ? (project.archivedAt ?? Date.now())
        : null;
    this.options.db.updateProject(updated);
    return this.publish(updated);
  }

  getProject(userId: string, projectId: string): ProjectRow {
    const project = this.options.db.getProject(userId, projectId);
    if (!project) throw new HttpError(404, "Project not found");
    return project;
  }

  /** A project that isn't archived, so it can take new chats and artefact changes. */
  getOpenProject(userId: string, projectId: string): ProjectRow {
    const project = this.getProject(userId, projectId);
    if (project.archivedAt !== null)
      throw new HttpError(409, "Unarchive the project to change it");
    return project;
  }

  /** Path of an artefact to download. */
  artefactPath(userId: string, projectId: string, name: string): string {
    const path = join(
      this.artefactDir(this.getProject(userId, projectId)),
      artefactName(name),
    );
    if (!isFile(path)) throw new HttpError(404, "Artefact not found");
    return path;
  }

  /** Stores an upload as an artefact, replacing any artefact with the same name. */
  async uploadArtefact(
    userId: string,
    projectId: string,
    name: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<ArtefactInfo> {
    const project = this.getOpenProject(userId, projectId);
    const fileName = artefactName(name);
    const dir = this.artefactDir(project);
    mkdirSync(dir, { recursive: true });
    mkdirSync(this.tmpDir(), { recursive: true });
    // Written elsewhere first, so chats never see half an upload.
    const tmp = join(this.tmpDir(), randomUUID());
    try {
      await Bun.write(tmp, new Response(body));
      chmodSync(tmp, 0o444);
      renameSync(tmp, join(dir, fileName));
    } finally {
      rmSync(tmp, { force: true });
    }
    return this.changedArtefact(project, fileName);
  }

  deleteArtefact(userId: string, projectId: string, name: string) {
    const project = this.getOpenProject(userId, projectId);
    const path = join(this.artefactDir(project), artefactName(name));
    if (!isFile(path)) throw new HttpError(404, "Artefact not found");
    rmSync(path);
    this.touch(project);
  }

  /**
   * Saves a file from a chat's folder as an artefact, for Pi's save_artefact tool. Never replaces an
   * artefact. Errors are worded for Pi.
   */
  async saveArtefact(
    projectId: string,
    cwd: string,
    path: string,
    name: string | undefined,
  ): Promise<ArtefactInfo> {
    const project = this.options.db.getProjectById(projectId);
    if (!project) throw new Error("This chat's project no longer exists.");
    if (project.archivedAt !== null)
      throw new Error(
        "The project is archived, so nothing can be saved to it until the user unarchives it.",
      );
    const dir = this.artefactDir(project);
    mkdirSync(dir, { recursive: true });

    let source: string;
    try {
      source = realpathSync(resolve(cwd, path));
    } catch {
      throw new Error(`There is no file at ${path}.`);
    }
    if (isInside(realpathSync(dir), source))
      throw new Error(`${path} already is an artefact of the project.`);
    if (!isInside(realpathSync(cwd), source))
      throw new Error(
        "Only files inside your working directory can be saved as artefacts.",
      );
    if (!statSync(source).isFile()) throw new Error(`${path} is not a file.`);

    const fileName = artefactName(name ?? basename(source));
    const target = join(dir, fileName);
    const taken = () =>
      new Error(
        `The project already has an artefact named ${fileName}. Artefacts can't be replaced, so save this one under another name.`,
      );
    if (existsSync(target)) throw taken();
    mkdirSync(this.tmpDir(), { recursive: true });
    const tmp = join(this.tmpDir(), randomUUID());
    try {
      await copyFile(source, tmp, constants.COPYFILE_FICLONE);
      const now = new Date();
      utimesSync(tmp, now, now);
      chmodSync(tmp, 0o444);
      // Unlike a rename, linking fails if an artefact with the name appeared in the meantime.
      linkSync(tmp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw taken();
      throw error;
    } finally {
      rmSync(tmp, { force: true });
    }
    return this.changedArtefact(project, fileName);
  }

  /** Points `artefacts` in a chat's folder at the project's artefacts, putting aside whatever is in the way. */
  linkArtefacts(projectId: string, cwd: string) {
    const project = this.options.db.getProjectById(projectId);
    if (!project) return;
    const dir = this.artefactDir(project);
    mkdirSync(dir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const link = join(cwd, ARTEFACTS_LINK);
    // Relative, so the data dir can move.
    const target = relative(cwd, dir);
    let current: string | null = null;
    try {
      current = readlinkSync(link);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Not a symlink: something Pi made after the link went missing.
      if (code === "EINVAL") renameSync(link, `${link}-${Date.now()}`);
      else if (code !== "ENOENT") throw error;
    }
    if (current === target) return;
    if (current !== null) rmSync(link);
    symlinkSync(target, link, "dir");
  }

  /**
   * The project's part of the system prompt of its chats. Null if the project is gone. Rebuilt for
   * every run, so changes to the instructions or artefacts apply to the next one.
   */
  prompt(projectId: string): string | null {
    const project = this.options.db.getProjectById(projectId);
    if (!project) return null;
    const artefacts = this.listArtefacts(project);
    const listed = artefacts
      .slice(0, PROMPT_ARTEFACTS)
      .map((artefact) => `- ${artefact.name} (${formatSize(artefact.size)})`);
    if (artefacts.length > PROMPT_ARTEFACTS)
      listed.push(`- …and ${artefacts.length - PROMPT_ARTEFACTS} more`);
    return [
      `This chat is part of the project "${project.name}".`,
      "",
      `The project's artefacts are files shared by all of its chats. They are in ${ARTEFACTS_LINK}/ in your working directory, a symlink to the project's artefact folder. Read them from there, but never create, change, rename or delete anything in it. Some search tools skip symlinks, so search it by path, e.g. \`rg pattern ${ARTEFACTS_LINK}/\`.`,
      artefacts.length
        ? `Artefacts:\n${listed.join("\n")}`
        : "The project has no artefacts yet.",
      "",
      "Files you create are not artefacts, and are only kept for this chat. When the user asks you to keep a file for the project, or you made something they will want in its other chats (such as a finished document), save it with the save_artefact tool. Don't save scratch or intermediate files. Artefacts can't be changed afterwards; save a new version under a new name instead.",
      ...(project.instructions
        ? [
            "",
            "The user's instructions for this project:",
            project.instructions,
          ]
        : []),
    ].join("\n");
  }

  private changedArtefact(project: ProjectRow, name: string): ArtefactInfo {
    this.touch(project);
    const artefact = this.listArtefacts(project).find((a) => a.name === name);
    if (!artefact) throw new Error(`Artefact ${name} disappeared`);
    return artefact;
  }

  private listArtefacts(project: ProjectRow): ArtefactInfo[] {
    const dir = this.artefactDir(project);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const artefacts: ArtefactInfo[] = [];
    for (const name of names) {
      try {
        // Only regular files: a symlink Pi put here could point anywhere.
        const stat = lstatSync(join(dir, name));
        if (stat.isFile())
          artefacts.push({
            name,
            size: stat.size,
            updatedAt: Math.round(stat.mtimeMs),
          });
      } catch {}
    }
    return artefacts.sort((a, b) => compareNames(a.name, b.name));
  }

  private touch(project: ProjectRow) {
    // Read again: the project may have been edited while an artefact was being written.
    const current = this.options.db.getProjectById(project.id);
    if (!current) return;
    const updated = { ...current, updatedAt: Date.now() };
    this.options.db.updateProject(updated);
    this.publish(updated);
  }

  private publish(project: ProjectRow): ProjectSummary {
    const summary = this.summary(project);
    this.options.publish(userTopic(project.userId), {
      type: "project_updated",
      project: summary,
    });
    return summary;
  }

  private summary(project: ProjectRow): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      instructions: project.instructions,
      archived: project.archivedAt !== null,
      artefacts: this.listArtefacts(project),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  private artefactDir(project: ProjectRow) {
    return join(this.options.dataDir, "artefacts", project.userId, project.id);
  }

  private tmpDir() {
    return join(this.options.dataDir, "tmp");
  }
}

function projectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new HttpError(400, "The project needs a name");
  if (trimmed.length > NAME_LENGTH)
    throw new HttpError(
      400,
      `Project names can be at most ${NAME_LENGTH} characters`,
    );
  return trimmed;
}

/** A file name that stays inside the artefact folder. */
function artefactName(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    // eslint-disable-next-line no-control-regex
    /[/\\\x00-\x1f]/.test(trimmed) ||
    Buffer.byteLength(trimmed) > 255
  )
    throw new HttpError(400, `"${name}" can't be used as a file name`);
  return trimmed;
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function compareNames(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
