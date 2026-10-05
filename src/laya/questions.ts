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

/**
 * Spielerrolle aus dem Saisonprofil (Text mit Werten je 90 Minuten, englisch wie das Modell): Laya ordnet ein,
 * welcher Spielertyp das ist. „Ähnliche Spieler“ vergleicht dann Rolle und Werte (similar.ts).
 */
export const ROLE = {
  role: {
    type: "choice",
    instructions: "Which football player role fits this season profile best?",
    criteria: {
      poacher: "a striker who mostly scores goals with many shots and few passes",
      target: "a target forward who wins aerial duels, holds up the ball and scores",
      winger: "a wide attacker who dribbles, crosses and creates chances",
      playmaker: "a creative attacking midfielder with many key passes and assists",
      box: "a box-to-box midfielder who tackles, recovers the ball and also shoots",
      deep: "a deep-lying playmaker with high pass accuracy and few shots",
      destroyer: "a ball-winning defensive midfielder with many tackles and interceptions",
      fullback: "a full-back or wing-back who defends and also crosses or assists",
      stopper: "a centre-back who wins duels, tackles and clears the ball",
      builder: "a ball-playing centre-back with many accurate passes",
    },
  },
};

export type Role = keyof typeof ROLE.role.criteria;

export const ROLE_DE: Record<Role, string> = {
  poacher: "Torjäger", target: "Zielspieler", winger: "Flügelspieler", playmaker: "Spielmacher", box: "Box-to-Box",
  deep: "Taktgeber", destroyer: "Abräumer", fullback: "Außenverteidiger", stopper: "Zweikämpfer hinten", builder: "Aufbauspieler hinten",
};
