import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { check } from "./runtime.js";
export const cloudFields = {
  hetzner: { name: "Hetzner", fields: ["token"] },
  aws: {
    name: "AWS",
    fields: ["accessKeyId", "secretAccessKey", "sessionToken?"],
  },
  gcp: { name: "Google Cloud", fields: ["serviceAccountJson"] },
  azure: {
    name: "Azure",
    fields: ["tenantId", "subscriptionId", "clientId", "clientSecret"],
  },
  digitalocean: { name: "DigitalOcean", fields: ["token"] },
};
export class CloudAccounts {
  constructor(root) {
    this.file = path.join(root, "cloud-accounts.json");
  }
  rows() {
    if (!fs.existsSync(this.file)) return [];
    const info = fs.lstatSync(this.file);
    check(
      info.isFile() &&
        !info.isSymbolicLink() &&
        (info.mode & 0o077) === 0 &&
        (process.getuid === undefined || info.uid === process.getuid()),
      "Cloud credentials must be private and owned by the current user.",
    );
    const rows = JSON.parse(fs.readFileSync(this.file, "utf8"));
    check(Array.isArray(rows), "Invalid cloud credential store.");
    return rows;
  }
  summary() {
    return {
      providers: cloudFields,
      accounts: this.rows().map(({ id, name, provider }) => ({
        id,
        name,
        provider,
      })),
    };
  }
  get(id, provider) {
    const row = this.rows().find(
      (row) => row.id === id && row.provider === provider,
    );
    check(row, "Select a saved credential for this cloud provider.");
    return row;
  }
  fingerprint(row) {
    return createHash("sha256").update(JSON.stringify(row)).digest("hex");
  }
  save(body) {
    const rows = this.rows();
    const previous = rows.find((row) => row.id === body.id);
    check(body.id === undefined || previous, "Cloud credential not found.");
    const provider = previous?.provider || body.provider;
    check(
      Object.hasOwn(cloudFields, provider),
      "Choose a supported cloud provider.",
    );
    check(
      typeof body.name === "string" &&
        body.name.trim().length > 0 &&
        body.name.trim().length <= 80 &&
        !/[\x00-\x1f]/.test(body.name),
      "Enter a credential name of 1–80 characters.",
    );
    check(
      !rows.some(
        (row) =>
          row.id !== previous?.id &&
          row.provider === provider &&
          row.name.toLowerCase() === body.name.trim().toLowerCase(),
      ),
      "Choose a unique credential name.",
    );
    const values = { ...previous?.values };
    check(
      body.values &&
        typeof body.values === "object" &&
        !Array.isArray(body.values),
      "Enter provider credentials.",
    );
    const fields = cloudFields[provider].fields;
    check(
      Object.keys(body.values).every((key) =>
        fields.some((field) => field.replace("?", "") === key),
      ),
      "Unknown credential field.",
    );
    for (const field of fields) {
      const key = field.replace("?", "");
      const value = body.values[key];
      if (value !== undefined) {
        check(
          typeof value === "string" &&
            value.length <= 131072 &&
            !value.includes("\0") &&
            (key === "serviceAccountJson" || !/[\r\n]/.test(value)),
          "Invalid credential value.",
        );
        if (value.trim()) values[key] = value.trim();
      }
      check(
        field.endsWith("?") || values[key],
        "Complete the required provider credential fields.",
      );
    }
    if (provider === "aws" && body.clearSessionToken === true)
      delete values.sessionToken;
    if (provider === "gcp") {
      let document;
      try {
        document = JSON.parse(values.serviceAccountJson);
      } catch {
        throw new Error("Enter a valid service-account JSON credential.");
      }
      check(
        document.type === "service_account" &&
          typeof document.private_key === "string" &&
          typeof document.client_email === "string" &&
          /^[a-z][a-z0-9-]{4,62}$/.test(document.project_id || "") &&
          (!document.token_uri ||
            document.token_uri === "https://oauth2.googleapis.com/token"),
        "Use an official Google service-account JSON key.",
      );
    }
    if (provider === "azure")
      for (const key of ["tenantId", "subscriptionId", "clientId"])
        check(
          /^[a-f0-9-]{36}$/i.test(values[key]),
          "Enter Azure tenant, subscription and client UUIDs.",
        );
    const row = {
      id: previous?.id || randomBytes(12).toString("hex"),
      provider,
      name: body.name.trim(),
      values,
    };
    const next = this.file + "." + randomBytes(6).toString("hex");
    fs.writeFileSync(
      next,
      JSON.stringify([...rows.filter((item) => item.id !== row.id), row]) +
        "\n",
      { mode: 0o600, flag: "wx" },
    );
    fs.renameSync(next, this.file);
    return { id: row.id };
  }
}
