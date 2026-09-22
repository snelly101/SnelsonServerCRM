import { describe, expect, it, beforeAll } from "vitest";
import { exportCompaniesCsv, importCompaniesCsv, importContactsCsv } from "@/services/csv";
import { listCompanies } from "@/services/companies";
import { makeUser } from "./helpers";

let actor: { id: string };
beforeAll(async () => {
  actor = await makeUser("sales", "csv importer");
});

describe("CSV import/export", () => {
  it("imports companies, skips duplicates, and reports row-level errors", async () => {
    const csv = [
      "name,status,website,industry,city",
      "Import One Ltd,prospect,importone.example,Retail,Leeds",
      "Import Two,customer,importtwo.example,Legal,York",
      "Import One Limited,prospect,importone.example,Retail,Leeds", // dup by domain + name
      ",prospect,,,", // missing name
    ].join("\n");
    const res = await importCompaniesCsv(csv, actor.id);
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(1);
    expect(res.errors).toBe(1);
    expect(res.results.find((r) => r.row === 4)?.message).toMatch(/duplicate/i);
    expect(res.results.find((r) => r.row === 5)?.status).toBe("error");
    const list = await listCompanies({ q: "Import" });
    expect(list.total).toBe(2);
  });

  it("imports contacts against existing companies by name and skips duplicate emails", async () => {
    const csv = [
      "companyName,firstName,lastName,email,roles",
      "Import One Ltd,Ann,Able,ann@importone.example,decision_maker;billing",
      "IMPORT ONE LIMITED,Ann,Able,ann@importone.example,technical", // dup email, name normalised
      "Nonexistent Co,Bob,Baker,bob@nowhere.example,",
    ].join("\n");
    const res = await importContactsCsv(csv, actor.id);
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.errors).toBe(1);
    expect(res.results[2].message).toMatch(/not found/);
  });

  it("exports companies with a header row", async () => {
    const out = await exportCompaniesCsv();
    const [header, ...rows] = out.split(/\r?\n/);
    expect(header.split(",")).toEqual(expect.arrayContaining(["name", "status", "website"]));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
