// Manages accounts: `bun users <command>`. Safe to run while the server is running.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AuthService } from "./auth";
import { errorMessage } from "./chats";
import { loadConfig } from "./config";
import { Db } from "./db";

const USAGE = `Usage: bun users <command>

  add <name>      Create an account
  passwd <name>   Set a new password, logging the account out everywhere
  list            List the accounts

Passwords are asked for, or read from the first line of stdin when it isn't a terminal.`;

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = new Db(join(config.dataDir, "clnk.db"));
const auth = new AuthService(db);

try {
  const [command, name, ...rest] = process.argv.slice(2);
  if (command === "list" && name === undefined) {
    for (const user of db.listUsers())
      console.log(user.passwordHash ? user.name : `${user.name} (no password)`);
  } else if (command === "add" && name && !rest.length) {
    const user = await auth.createUser(name, await askPassword());
    console.log(`Created ${user.name}.`);
  } else if (command === "passwd" && name && !rest.length) {
    const user = db.getUserByName(name);
    if (!user) throw new Error(`There is no user named ${name}`);
    await auth.setPassword(user.id, await askPassword());
    console.log(`Changed the password of ${user.name}.`);
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
} finally {
  db.close();
}

async function askPassword(): Promise<string> {
  if (!process.stdin.isTTY)
    return (await Bun.stdin.text()).split(/\r?\n/)[0] ?? "";
  const password = await readHidden("Password: ");
  if (password !== (await readHidden("Again: ")))
    throw new Error("The passwords don't match");
  return password;
}

/** Reads a line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let input = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          // Ctrl+C
          done();
          process.exit(130);
        } else if (char === "\r" || char === "\n" || char === "\u0004") {
          done();
          return resolve(input);
        } else if (char === "\u007f" || char === "\b") {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}
