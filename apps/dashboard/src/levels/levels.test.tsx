import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LevelBadge } from "./LevelBadge";
import { levelOf, matchesLevel, type Labelled, type MyTeam, type Team } from "./levels";

const TEAMS: Team[] = [{ key: "billing", name: "Billing", created_at: "2026-10-01T00:00:00Z", members: [], repos: [] }];
const MINE: MyTeam[] = [{ key: "billing", name: "Billing", role: "member" }];

const badge = (fact: Labelled, teams?: Team[], mine?: MyTeam[]) => {
  const { container } = render(<LevelBadge fact={fact} teams={teams} mine={mine} />);
  return container.querySelector(".level") as HTMLElement;
};

afterEach(cleanup);

describe("level badge", () => {
  it.each([
    [{ scope: "personal:u1", level: "personal" }, "Personal"],
    [{ scope: "repo:gh/acme/proj", level: "repository" }, "Repository"],
    [{ scope: "team:billing", level: "team", team: "billing", team_name: "Billing", own_team: false }, "Team: Billing"],
    [{ scope: "global", level: "organisation" }, "Organisation"],
  ] as [Labelled, string][])("labels %o as %s", (fact, text) => {
    const el = badge(fact);
    expect(el.textContent).toBe(text);
    expect(el.getAttribute("title")).toBe(fact.scope);
    expect(el.querySelector(".badge")!.className).toBe(`badge level-${fact.level}`);
  });

  it("says when the team is yours", () => {
    const el = badge({ scope: "team:billing", level: "team", team: "billing", team_name: "Billing", own_team: true });
    expect(el.querySelector(".own-team")!.textContent).toBe("your team");
  });

  it("works the level out from scope when the server didn't label it", () => {
    expect(badge({ scope: "personal:u1" }).textContent).toBe("Personal");
    cleanup();
    expect(badge({ scope: "repo:gh/acme/proj" }).textContent).toBe("Repository");
    cleanup();
    expect(badge({ scope: "global" }).textContent).toBe("Organisation");
    cleanup();
    expect(badge({ scope: "team:billing" }, TEAMS, MINE).textContent).toBe("Team: Billingyour team");
    cleanup();
    expect(badge({ scope: "team:billing" }, TEAMS, []).textContent).toBe("Team: Billing");
    cleanup();
    expect(badge({ scope: "team:ops" }).textContent).toBe("Team: ops");
  });

  it("prefers the server's labels over the fallback", () => {
    expect(levelOf({ scope: "team:billing", level: "team", team: "billing", team_name: "Payments", own_team: false }, TEAMS, MINE)).toEqual({
      level: "team",
      team: { key: "billing", name: "Payments", own: false },
    });
  });
});

describe("matchesLevel", () => {
  it.each([
    ["", "global", true],
    ["personal", "personal:u1", true],
    ["personal", "global", false],
    ["repository", "repo:gh/acme/proj", true],
    ["repository", "team:billing", false],
    ["team:billing", "team:billing", true],
    ["team:billing", "team:ops", false],
    ["global", "global", true],
    ["global", "personal:u1", false],
  ])("level %s against scope %s is %s", (value, scope, ok) => {
    expect(matchesLevel({ scope }, value)).toBe(ok);
  });
});
