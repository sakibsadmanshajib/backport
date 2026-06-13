type DestinationResult =
  | Readonly<{
      base: string;
      mode: "ai" | "normal" | "sibling";
      pullRequestNumber: number;
      status: "created";
    }>
  | Readonly<{
      base: string;
      reason: string;
      status: "failed";
    }>;

export type { DestinationResult };
