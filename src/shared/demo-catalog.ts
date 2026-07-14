import type { CardIdentity, Valuation } from "./types";

export interface DemoCatalogEntry {
  keywords: string[];
  identity: Partial<CardIdentity>;
  valuation: Valuation;
}

// POC seed values only. These make the live HUD demonstrable before a real comp
// provider is wired in, and are deliberately labeled as seeded-demo downstream.
export const DEMO_CATALOG: DemoCatalogEntry[] = [
  {
    keywords: ["michael jordan", "1986", "fleer", "57"],
    identity: {
      sport: "Basketball",
      player: "Michael Jordan",
      year: "1986",
      set: "Fleer",
      cardNumber: "57"
    },
    valuation: {
      low: 4500,
      high: 8000,
      maxBid: 5800,
      currency: "USD",
      confidence: 0.64,
      source: "seeded-demo",
      compCount: 6,
      reasons: ["Matched local POC seed catalog for an iconic card."],
      warnings: ["Demo seed value; verify grade and current sold comps before bidding."]
    }
  },
  {
    keywords: ["victor wembanyama", "prizm", "silver"],
    identity: {
      sport: "Basketball",
      player: "Victor Wembanyama",
      year: "2023",
      set: "Prizm",
      parallel: "Silver"
    },
    valuation: {
      low: 450,
      high: 900,
      maxBid: 650,
      currency: "USD",
      confidence: 0.58,
      source: "seeded-demo",
      compCount: 4,
      reasons: ["Matched local POC seed catalog for a common live-show test card."],
      warnings: ["Demo seed value; verify parallel, grade, and sold comps."]
    }
  },
  {
    keywords: ["lebron james", "2003", "topps chrome", "111"],
    identity: {
      sport: "Basketball",
      player: "LeBron James",
      year: "2003",
      set: "Topps Chrome",
      cardNumber: "111"
    },
    valuation: {
      low: 900,
      high: 2400,
      maxBid: 1650,
      currency: "USD",
      confidence: 0.57,
      source: "seeded-demo",
      compCount: 5,
      reasons: ["Matched local POC seed catalog for a recognizable rookie card."],
      warnings: ["Demo seed value; grade and centering can move this card materially."]
    }
  },
  {
    keywords: ["luka doncic", "2018", "prizm", "280"],
    identity: {
      sport: "Basketball",
      player: "Luka Doncic",
      year: "2018",
      set: "Prizm",
      cardNumber: "280"
    },
    valuation: {
      low: 200,
      high: 700,
      maxBid: 475,
      currency: "USD",
      confidence: 0.56,
      source: "seeded-demo",
      compCount: 5,
      reasons: ["Matched local POC seed catalog for a modern rookie card."],
      warnings: ["Demo seed value; verify raw vs graded and parallel."]
    }
  }
];
