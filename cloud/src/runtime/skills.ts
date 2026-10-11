import { section } from "@earendil-works/pi-durable";
import { parse } from "yaml";
import type { Computer } from "./computer.ts";

export type Skill = { name: string; description: string; path: string; disableModelInvocation: boolean };
export type SkillDiagnostic = { path: string; message: string };
export const skillsDirectory = (computer: Pick<Computer, "workspace">) => `${computer.workspace}/.agents/skills`;

// Read just the headers on the sandbox computer, not the Worker's file system or skill bodies.
// A skill directory owns its supporting files, so do not search inside it for more skills.
const SCAN = String.raw`import json, os, sys
root = sys.argv[1]
os.makedirs(root, exist_ok=True)
files, diagnostics = [], []
for visited, (directory, dirs, names) in enumerate(os.walk(root)):
    if visited >= 2000 or len(files) >= 200:
        diagnostics.append({"path": root, "message": "Skill scan limit reached (200 files or 2000 directories)."})
        break
    dirs[:] = sorted(name for name in dirs if not name.startswith(".") and name != "node_modules")
    if "SKILL.md" not in names:
        continue
    dirs[:] = []
    path = os.path.join(directory, "SKILL.md")
    try:
        with open(path, "rb") as file:
            first = file.readline(16385).decode("utf-8-sig").rstrip("\r\n \t")
            if first != "---":
                raise ValueError("SKILL.md needs YAML frontmatter.")
            header, size = [], 0
            while True:
                line = file.readline(16385)
                size += len(line)
                if not line or size > 16384:
                    raise ValueError("Missing frontmatter delimiter or header exceeds 16 KiB.")
                text = line.decode("utf-8")
                if text.rstrip("\r\n \t") in ("---", "..."):
                    break
                header.append(text)
            files.append({"path": path, "header": "".join(header)})
    except (OSError, UnicodeError, ValueError) as error:
        diagnostics.append({"path": path, "message": str(error)})
print(json.dumps({"files": files, "diagnostics": diagnostics}, ensure_ascii=True))`;

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export async function discoverSkills(computer: Computer, signal: AbortSignal): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const root = skillsDirectory(computer);
	const result = await computer.exec(`python3 - ${quote(root)} <<'GLAV_SKILLS_PY'\n${SCAN}\nGLAV_SKILLS_PY`, signal);
	if (result.exitCode !== 0) throw new Error(`Skill discovery failed: ${result.output.slice(-1000)}`);
	const scanned: unknown = JSON.parse(result.output);
	if (!record(scanned) || !Array.isArray(scanned.files) || !Array.isArray(scanned.diagnostics)) throw new Error("Invalid skill scan result.");
	const skills: Skill[] = [], diagnostics: SkillDiagnostic[] = [];
	for (const item of scanned.diagnostics) {
		if (!record(item) || typeof item.path !== "string" || typeof item.message !== "string") throw new Error("Invalid skill scan diagnostic.");
		diagnostics.push({ path: item.path, message: item.message });
	}
	const names = new Set<string>();
	for (const file of scanned.files) {
		if (!record(file) || typeof file.path !== "string" || typeof file.header !== "string") throw new Error("Invalid skill scan file.");
		try {
			const header: unknown = parse(file.header);
			if (!record(header)) throw new Error("Frontmatter must be a YAML mapping.");
			const parent = file.path.split("/").at(-2)!;
			const name = typeof header.name === "string" && header.name.trim() ? header.name.trim() : parent;
			if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Use a skill name of up to 64 lowercase letters, numbers, and hyphens.");
			if (typeof header.description !== "string" || !header.description.trim() || header.description.length > 1024) throw new Error("Description must contain 1-1024 characters.");
			if (names.has(name)) throw new Error(`Duplicate skill name: ${name}. The first path takes precedence.`);
			names.add(name);
			skills.push({ name, description: header.description.trim(), path: file.path, disableModelInvocation: header["disable-model-invocation"] === true });
		} catch (error) { diagnostics.push({ path: file.path, message: error instanceof Error ? error.message : String(error) }); }
	}
	return { skills, diagnostics };
}

export function skillsSection(computer: Computer) {
	return section("skills", async (input, context) => {
		// Accounts without computer tools must not start a sandbox or receive its skill catalog.
		if (!input.agent.tools.some((tool) => tool.name === "read_file")) return undefined;
		const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
		const { skills, diagnostics } = await discoverSkills(computer, signal);
		for (const diagnostic of diagnostics) console.warn("Skill discovery:", diagnostic);
		const visible = skills.filter((skill) => !skill.disableModelInvocation);
		return [
			`Skills are stored on your computer at ${skillsDirectory(computer)}/<skill-name>/SKILL.md, with YAML frontmatter containing name and description.`,
			"When a task matches an available skill's description, use read_file to read its SKILL.md before doing the work. Follow its instructions using your tools. Resolve supporting file and script paths relative to the directory containing that SKILL.md.",
			visible.length ? `<available_skills>\n${visible.map((skill) => `  <skill><name>${xml(skill.name)}</name><description>${xml(skill.description)}</description><location>${xml(skill.path)}</location></skill>`).join("\n")}\n</available_skills>` : "No skills are available for automatic use.",
		].join("\n");
	});
}
