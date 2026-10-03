/**
 * Die eine Frage an Laya pro Schlagzeile (englisch, wie die ESPN-Texte). Gegen 40 echte Schlagzeilen geprueft
 * (tools/laya/README.md): Transfergeruechte sicher (0,8–0,9), Unklares kommt mit niedriger Sicherheit —
 * deshalb zeigt Arena ein Etikett erst ab MIN_P.
 */

export const QUESTIONS = {
  kind: {
    type: "choice",
    instructions: "What is this sports news headline mainly about?",
    criteria: {
      signed: "a completed signing, transfer, trade, loan or new contract with a new club",
      rumor: "a rumored or possible transfer: interest, bid, target or negotiation",
      extension: "a contract extension or renewal with the current club",
      injury: "an injury, illness or return from injury",
      match: "a match, result, goal, record or player performance",
      other: "anything else: awards, kits, opinion, scandal, business, coaches",
    },
  },
};

export type Kind = keyof typeof QUESTIONS.kind.criteria;

/** Etikett auf Deutsch; leer = keins zeigen */
export const KIND_DE: Record<Kind, string> = {
  signed: "Transfer fix",
  rumor: "Gerücht",
  extension: "Verlängerung",
  injury: "Verletzung",
  match: "Spiel",
  other: "",
};

/** Transfer im weiteren Sinn (Filter „Transfers“) */
export const TRANSFER_KINDS: Kind[] = ["signed", "rumor", "extension"];

export const MIN_P = 0.45;
