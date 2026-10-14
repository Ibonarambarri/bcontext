/**
 * The MCP tool schema is injected into the model's context on every single
 * turn, so its size is a running cost paid by every agent on every request —
 * not a one-off. Measured against production before this work: 55 tools,
 * 37.306 bytes, ~9.300 tokens before anyone types anything. 35 of those are
 * ours (24.198 bytes, ~6.050 tokens); the rest are granted capabilities.
 *
 * A budget is the only thing that keeps that from drifting back up. Tools get
 * added one at a time, each addition looks negligible, and nobody measures the
 * total — which is exactly how it reached 6k tokens in the first place.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITY_ROUTING_TOOLS, TOOLS, visibleTools } from "./server";
import { VERBS, type Grant, type Verb } from "@/lib/auth/grants";

/** Bytes of minified JSON, the shape the schema actually travels in. */
function schemaBytes(tools: readonly unknown[]): number {
  return JSON.stringify(tools).length;
}

describe("MCP tool surface budget", () => {
  it("stays under budget", () => {
    const bytes = schemaBytes(TOOLS);
    // Roughly 4 bytes per token. Started at 24.143 bytes (~6.036 tokens); this
    // budget ratchets DOWN as consolidation lands and never silently back up.
    //
    // A note on expectations, since the first estimate was wrong: consolidating
    // tools saves far less than the tool count suggests. Eight view tools
    // became two and the surface moved 1%, because the weight was never in the
    // per-tool boilerplate — it was one 1.7 KB query contract inlined four
    // times. Hoisting the repeats into `$defs` did the real work. The same
    // held for the rest: 31 tools became 17 and the total fell only 10%.
    //
    // Lowered from 24.500 once the remaining groups landed AND tools/list
    // started filtering by permission — which is where the real saving is, and
    // why the number below is no longer the number most callers pay. See the
    // per-principal test underneath: a read-only agent pays under 9 KB.
    //
    // Raised once, from 22.000, and worth recording as the shape of a
    // legitimate raise: invitations arrived as three ops on the two admin
    // tools, and the ratchet caught them at 22.492. Shortening the prose
    // recovered 46 bytes — the rest is the schema of ops that genuinely did
    // not exist before. A new capability paying ~450 bytes is not the drift
    // this budget exists to stop; twenty descriptions growing a line each,
    // with nobody noticing the total, is. The test asks for the case to be
    // made rather than for the number to hold, so: made.
    //
    // Note what the raise buys, since only admins ever see it. `visibleTools`
    // filters by permission, so an agent without the admin verb pays nothing
    // for any of this.
    //
    // Raised a second time, from 22.500, for subtasks — two new tools
    // (`subtasks`, `subtasks_write`) plus a `subtasks` field on create. The
    // first cut cost 3.1 KB; flattening `subtasks_write` from a five-branch
    // `oneOf` (node_id and if_updated_at restated per branch) to one object
    // with an enum `op`, and shortening both descriptions, brought it to
    // 1.7 KB. What is left is the capability itself: the ops that let an
    // agent edit one step of a task without re-sending the task, which is a
    // net saving on every turn that uses them. A read-only principal pays
    // ~460 bytes for `subtasks` and nothing for the write tool.
    //
    // Nudged from 24.500 to 24.700 for the `archived` status: one enum value
    // that has to appear in every status enum (create, update, list) plus
    // the `include_archived` switch on list — 100 bytes of vocabulary, not
    // prose.
    //
    // 24.700 → 25.300 for agent skills (F08): `skills` gains op=get (id,
    // input) and `skills_write(op=import)` arrives — ~550 bytes, one tool and
    // one op; a reader pays ~110 of them.
    //
    // 25.300 → 26.100 for `ask_nexo`: one new read tool (~780 bytes) that
    // gives agents the answer shape they were reconstructing by hand —
    // confidence, freshness, conflicts, gaps, pending signals — so the turns
    // it saves are worth more than the bytes it costs.
    //
    // 26.100 → 27.800 for the agent's daily loop (F07): `brief` is one new
    // read-only tool (~680 bytes) and `nodes_write` gained op=append and
    // op=replace_block (~900 bytes, two branches plus the sentence that says
    // when they conflict). `nodes(op=list)` accepts the full view query too,
    // but as an opaque object: the 1.7 KB contract is already paid once in
    // `views` and would have doubled the cost of every reader's turn. Own
    // increment: +1.700; other branches in flight raise it for their own ops.
    //
    // 27.800 → 31.700 for capabilities over the MCP: two admin
    // tools (`capabilities`, `capabilities_write`, 3.6 KB — discover, connect,
    // OAuth hand-off, grant, revoke, disconnect) plus `provenance` on create
    // (~200 bytes). Only admins pay the 3.6 KB; the external tools themselves
    // now cost every principal LESS, see the budget test below.
    //
    // 31.700 → 32.100 for typed credentials: ~290 bytes across two
    // descriptions saying that one credential node is one credential (type,
    // environment, service, fields) and that op=get returns its shape rather
    // than its values. This is the rare case where prose in the schema is the
    // cheap option: an agent that builds one shared "vault" node, or that
    // pastes a secret into content_md, costs a rotation and a cleanup — and
    // the alternative, letting it find out from an error, costs a turn every
    // time. Two sentences, paid once per turn, against that.
    //
    // 32.100 → 32.200 for the `goal` kind: one enum value repeated across the
    // four kind enums (create, update, list, graph filter) plus
    // `contributes_to` in the relation enum — 80 bytes of vocabulary, no
    // prose. The tools that make goals writable (`goals`, `goals_write`) are
    // not in this number and must make their own case on top of it.
    //
    // 32.200 → 35.000, and here is that case. Measured, not estimated: 2.761
    // bytes, of which `goals` is 657, `goals_write` 2.094 and the last ten are
    // `goals:write` appearing in the two admin verb enums. The first cut was
    // 2.851; dropping the `op` enum from `goals` (there is one read there, so
    // an `id` filter says it in fewer bytes) and tightening both descriptions
    // recovered 90. `goals_write` is already flat — one object with an `op`
    // enum, the shape subtasks_write was reduced to — and its 1.445 bytes of
    // schema are 18 fields that each carry a distinct argument; there is no
    // duplicated sub-schema left to hoist.
    //
    // What it buys is the reason it is not a `nodes_write` data patch. Moving
    // one key result through `nodes_write` means reading the node, re-sending
    // `data` whole — every other key result included — and pinning
    // `if_updated_at`, which is three turns and a lost-update hazard for
    // changing one number. `goals_write(op=checkin)` is one call that names
    // the number it moves, retried on a lost race because "the revenue KR is
    // at 42 now" is unambiguous whatever else changed on the node. Check-ins
    // are the thing that happens weekly, forever; creates happen once.
    //
    // Who pays: a writer pays all 2.751, a read-only principal pays the 657 of
    // `goals` (see the per-principal test below), and an agent with neither
    // pays nothing but the ten bytes in the admin enums it cannot see either.
    //
    // 35.000 → 35.400 for the brief's goals section and the `strategic` flag,
    // and note what is NOT in this number: no input field was added to either
    // tool. The 371 bytes are prose — ~316 on `brief`, ~55 on `list_changes` —
    // because both tools document their RESPONSE shape in the description, and
    // a section an agent is never told about is a section it never reads. A
    // first cut was 431; shortening both clauses recovered 60.
    //
    // What it buys is the difference between a queue that is a topological
    // order and one that has intent: `brief` now says which objective each
    // unblocked item pushes and how much trouble that objective is in, which
    // goals are past the cadence they promised, and which writes touched the
    // North Star. Reconstructing any of that costs an agent a `goals` call, a
    // `list_changes` call and the arithmetic — every session, before it can
    // pick what to do.
    //
    // Who pays: both are read tools, so this lands entirely on the read-only
    // principal (see the per-principal test below, 11.700 → 12.100). That is
    // the right pocket — a reader deciding what to work on is exactly who the
    // section is for.
    // 35.000 → 38.300 for datasets. Measured: 3.287 bytes — `data` 1.691,
    // `data_write` 1.490, and 106 for the sentence in `nodes` that says
    // op=get on a `data` node returns its schema and not its rows. The first
    // cut was 3.476; shortening both descriptions to stop restating what the
    // schema already spells out (the operator list, the filter shape) gave
    // back 189. There is no duplicated sub-schema left to hoist: the query
    // contract appears once, in `data`, and nowhere else.
    //
    // The 830 bytes of that are the query DSL are the arguable half, so here
    // is the argument. It is inline rather than an opaque object — which is
    // what `nodes(op=list)` does with the view query, and for a good reason
    // there: that contract is already paid once in `views`. This one is paid
    // nowhere else. An agent that cannot see the operators does not stop
    // asking the question; it pulls the rows and filters them itself, and a
    // dataset is up to 200.000 rows. One `op=query` that never happens costs
    // more in a single turn than the schema costs in a hundred.
    //
    // What the rest buys is the model itself. A `data` node used to keep its
    // table in `content_md` as a ```csv block: every read of the node dumped
    // the whole table into the context, every edit rewrote the body, and the
    // block was chunked into the vector index where three thousand customers
    // competed with the workspace's actual knowledge in every search. The rows
    // are now their own table; these two tools are the only way in and out of
    // it, and the node is back to costing what a schema costs.
    //
    // Los dos párrafos de arriba llegaron por ramas distintas que partían del
    // mismo 35.000, así que ninguno de sus dos números (35.400 y 38.300) es el
    // total al entrar juntas. Medido con ambas dentro: 38.658. El presupuesto
    // es ese, redondeado, y no la suma de dos estimaciones — que es justo el
    // tipo de aritmética a ojo que este test existe para impedir.
    //
    // 38.700 → 38.900 for the roadmap: 154 bytes of prose on `views`, no input
    // field. The system `roadmap` view resolves to rows the API computes —
    // goals × now/next/later, cards placed by `contributes_to` — and a tool
    // that returns a shape its description never mentions is a shape an agent
    // never asks for. The sentence also carries the one rule that saves the
    // wrong turn: a card moves by editing the node, never the view.
    //
    // Held at 38.900 when `brief` gained `capabilities:{external_tools,skills}`
    // (measured 38.868 after it): the clause that names the section cost 46
    // bytes; two phrases of the same description and the `capabilities`
    // description, which no longer has a naming scheme to explain, were
    // tightened to pay for most of it. External tools and skills are no
    // longer in tools/list at all, so the one line that says "there is
    // something to search for" is what keeps them from being invisible.
    //
    // Held at 38.900 when static credentials moved from env names to a
    // pasted token (`auth.secret`): the one clause an agent must not miss —
    // write-only, never returned — costs 64 bytes and is paid by trimming
    // the rest of the same description, not by a raise.
    const BUDGET = 38_900;
    expect(
      bytes,
      `The tool schema is ${bytes} bytes (~${Math.round(bytes / 4)} tokens), over ` +
        `the ${BUDGET}-byte budget. Every agent pays this on every turn. Either ` +
        `consolidate, shorten descriptions, or make the case for raising the ` +
        `budget deliberately.`,
    ).toBeLessThanOrEqual(BUDGET);
  });

  const grantWith = (verbs: readonly Verb[]): Grant => ({
    workspaceId: "ws",
    principal: { kind: "agent", id: "agent-1" },
    verbs,
    reach: { type: "all" },
  });

  it("charges a read-only principal only for what it may call", () => {
    // The budget above is what a fully-privileged principal pays. Nobody else
    // should: an agent granted `read` has no business being shown — or paying
    // for — nodes_write, tags_write, admin_write and the rest.
    const reader = visibleTools(grantWith(["read"]));
    const names = reader.map((tool) => tool.name);

    expect(names).not.toContain("nodes_write");
    expect(names).not.toContain("links_write");
    expect(names).not.toContain("views_write");
    expect(names).not.toContain("ingest_write");
    expect(names).not.toContain("tags_write");
    expect(names).not.toContain("admin");
    expect(names).not.toContain("admin_write");
    // Alive, and which workspace am I in: never filtered away.
    expect(names).toContain("ping");
    expect(names).toContain("list_workspaces");

    const bytes = schemaBytes(reader);
    expect(
      bytes,
      `A read-only principal is paying ${bytes} bytes for tools it cannot call.`,
      // 9.000 → 9.200 with `archived` (the same enum value, in the read
      // tool's status filter) — the point of this number is that write tools
      // never leak into a reader's list, and they do not. 9.200 → 9.400 for
      // skills(op=get): the id/input fields and the sentence that says a
      // skill is yours to run. 9.400 → 10.200 with `ask_nexo`, which is a
      // read and so is rightly on a reader's list.
      // skill is yours to run. 10.200 → 11.000 for `brief` (a read, so every
      // reader sees it) and `query` on list. 11.000 → 11.050 for the `goal`
      // kind in the read tools' kind filters: 16 bytes, and a reader that
      // cannot see goals could not ask what the workspace is aiming at.
      // 11.050 → 11.700 for the `goals` read tool itself (657 bytes): the
      // aggregate a reader would otherwise rebuild by hand out of every goal
      // node's `data` — progress across the key results, pace against the
      // horizon, and the tree that says which goal answers to which.
      // 11.700 → 12.100: the whole of the goals/strategic prose above, since
      // `brief` and `list_changes` are both reads. No input schema grew.
      // 11.700 → 13.500 for datasets: 1.691 for `data` and 106 for the
      // sentence on `nodes`, and both of those are reads, so a reader rightly
      // pays them. It is the largest single raise this number has taken, and
      // it is also the one that makes a reader's turns SMALLER: the tool it
      // now pays for is what stops a `data` node arriving as a table.
      // `data_write` stays out of a reader's list entirely.
      // Mismo caso que el total: 12.100 y 13.500 venían de ramas paralelas.
      // Medido con las dos dentro, un lector paga 13.880. 13.900 → 14.100 for
      // the roadmap sentence on `views` — a read, so a reader rightly pays it.
      // Held at 14.100 (measured 14.096) when `brief` started counting the
      // external tools and skills a reader can search for.
    ).toBeLessThanOrEqual(14_100);
    expect(bytes).toBeLessThan(schemaBytes(TOOLS) / 2);
  });

  it("hides the admin tools from a principal without the admin verb", () => {
    // The one verb that is not implied by anything else: an agent that can
    // write every node in the workspace still may not hand out access, so it
    // should not be told the tool exists.
    const editor = visibleTools(grantWith(["read", "write", "delete"])).map((t) => t.name);
    expect(editor).not.toContain("admin");
    expect(editor).not.toContain("admin_write");
    expect(editor).toContain("nodes_write");

    const admin = visibleTools(grantWith(VERBS)).map((t) => t.name);
    expect(admin).toContain("admin");
    expect(admin).toContain("admin_write");
    // The capability catalog is admin territory too: connecting an external
    // MCP server hands its tools to principals, which is a grant by another
    // name.
    expect(editor).not.toContain("capabilities");
    expect(editor).not.toContain("capabilities_write");
    expect(admin).toContain("capabilities");
    expect(admin).toContain("capabilities_write");
  });

  describe("external tools and skills: two routing tools, whatever is granted", () => {
    // What a granted capability used to put in front of a principal, on every
    // turn: a real MCP server is 20-40 tools with their own inputSchemas — one
    // GitHub grant was 13 KB in production, more than half the native surface.
    // Now nothing external is ever inlined: tools/list is the native tools for
    // the principal's verbs plus exactly `capability_search` and
    // `capability_call`, and their cost does not move with the grants.
    it("is exactly capability_search and capability_call", () => {
      expect(CAPABILITY_ROUTING_TOOLS.map((tool) => tool.name)).toEqual(["capability_search", "capability_call"]);
      expect(TOOLS.map((tool) => tool.name)).not.toContain("capability_search");
      expect(TOOLS.map((tool) => tool.name)).not.toContain("capability_call");
    });

    it("costs every principal the same small fixed amount", () => {
      const bytes = schemaBytes(CAPABILITY_ROUTING_TOOLS);
      // Two tools, one query and one ref. The descriptions carry the two rules
      // an agent cannot infer — refs are stable, schemas come inline for few
      // hits or an exact ref — and nothing else.
      expect(bytes).toBeLessThanOrEqual(1_400);
      for (const verbs of [["read"], ["read", "write"], VERBS] as const) {
        const native = visibleTools(grantWith(verbs));
        // One list, so one comma instead of a second pair of brackets.
        expect(schemaBytes([...native, ...CAPABILITY_ROUTING_TOOLS])).toBe(schemaBytes(native) + bytes - 1);
      }
    });

    it("annotates both: the search is read-only, the call is not", () => {
      const [search, call] = CAPABILITY_ROUTING_TOOLS;
      expect(search!.annotations).toMatchObject({ readOnlyHint: true });
      expect(call!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    });
  });

  it("classifies every tool, so a new one cannot leak in unreasoned", () => {
    // visibleTools fails closed on an unknown name. That is the safe default
    // and a silent one, so this is the test that makes it loud: add a tool,
    // decide which verbs it needs, or watch it vanish from every tools/list.
    const everything = visibleTools(grantWith(VERBS)).map((tool) => tool.name);
    const missing = TOOLS.map((tool) => tool.name).filter((name) => !everything.includes(name));
    expect(
      missing,
      `Unclassified tools are hidden from every principal. Add them to ` +
        `READ_TOOLS / WRITE_TOOLS / ADMIN_TOOLS in server.ts.\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("annotates every native tool", () => {
    // A client that auto-approves reads and prompts on writes can only do it
    // if we say which is which. Before this, none of the native tools did.
    const unannotated = TOOLS.filter((tool) => !tool.annotations).map((tool) => tool.name);
    expect(unannotated).toEqual([]);
    for (const tool of TOOLS) {
      const a = tool.annotations!;
      expect(
        a.readOnlyHint === true || a.destructiveHint === true,
        `${tool.name} claims neither readOnlyHint nor destructiveHint`,
      ).toBe(true);
      expect(
        a.readOnlyHint === true && a.destructiveHint === true,
        `${tool.name} cannot be both read-only and destructive`,
      ).toBe(false);
    }
  });

  it("never inlines the same sub-schema twice in one tool", () => {
    // The property that actually matters, rather than a percentage of the
    // total. `views_write` is legitimately the largest tool — it carries four
    // operations — so "no tool exceeds N% of the surface" would only ever
    // punish honest grouping. What is never justified is paying for the same
    // 1.7 KB contract twice inside one schema, which is exactly what the eight
    // separate view tools were doing four times over.
    const offenders: string[] = [];

    for (const tool of TOOLS) {
      const seen = new Map<string, number>();
      const visit = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(visit);
        const obj = node as Record<string, unknown>;
        if (obj.type === "object" && obj.properties) {
          const key = JSON.stringify(obj);
          if (key.length > 400) seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        Object.values(obj).forEach(visit);
      };
      // Skip `$defs` itself: a definition is meant to appear once there and be
      // referenced elsewhere.
      const schema = { ...(tool.inputSchema as Record<string, unknown>) };
      delete schema.$defs;
      visit(schema);

      for (const [key, count] of seen) {
        if (count > 1) {
          offenders.push(`${tool.name}: a ${key.length}-byte schema appears ${count}×`);
        }
      }
    }

    expect(
      offenders,
      `Hoist the repeat into $defs and reference it — dedupeSubSchemas does this ` +
        `automatically for discriminated unions.\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
