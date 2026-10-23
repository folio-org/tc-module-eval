/** Where a reviewer starts checking a checklist item: a file, optionally a line, and what to look at there. */
export interface FrontendChecklistStartingPoint {
  path: string;
  line?: number;
  note: string;
}

/**
 * One thing an agent review must assess for a checklist item. The ID is short and per run (`F003-C1#2`); the
 * subject names what it is about (an id, a path and line, a page), or is absent when the obligation is the whole
 * item. `path` and `line` locate a subject in the repository, so a review can be checked for citing it.
 */
export interface FrontendChecklistObligation {
  id: string;
  subject?: string;
  path?: string;
  line?: number;
  /** Left out of the agent review by the obligation limit, so it has no agent result. */
  withheld?: boolean;
}

/** A manual check phrased as the desired state, with a stable ID such as `F005-C1`. */
export interface FrontendChecklistItem {
  id: string;
  title: string;
  startingPoints: FrontendChecklistStartingPoint[];
  /** Never given to the agent; only a human reviewer can check it. Its obligations are not reviewed. */
  reviewerOnly: boolean;
  obligations: FrontendChecklistObligation[];
}

/** The manual checklist of an F criterion's report (`criterionDetails.checklist`); empty for pass and not applicable. */
export interface FrontendChecklist {
  items: FrontendChecklistItem[];
}
