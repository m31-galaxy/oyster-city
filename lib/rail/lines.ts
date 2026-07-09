// National Rail lines drawn on the map, and how their live data maps onto our
// network. TfL's Unified API serves no Arrivals for national-rail operators,
// so these lines get predictions from Darwin (National Rail's official
// prediction engine) via the LDBWS departure-board web service instead — see
// lib/rail/arrivals.ts. This module is configuration only (no secrets, safe
// to import from client code): adding a future NR line to the map means
// adding its registry entry here alongside the usual colour / hollow /
// build-clip registrations.

export interface RailLineConfig {
  /** Line id used across the map (matches the network-data line id). */
  lineId: string;
  /** Human name used in Prediction.lineName. */
  lineName: string;
  /** LDBWS operator codes owning this line's services (filters boards). */
  operatorCodes: string[];
  /**
   * CRS codes of the stations whose combined arrival/departure boards are
   * polled. Chosen so every service pattern on the drawn line calls at (or
   * is due at) at least one of them inside the board's time window — one
   * board sighting yields the service's full remaining ladder (pending
   * previous calling points + the board row + subsequent calling points).
   */
  boardCrs: string[];
  /** CRS -> our network station id, for every drawn station on the line. */
  crsToStation: Record<string, string>;
}

export const RAIL_LINES: RailLineConfig[] = [
  {
    lineId: "thameslink",
    lineName: "Thameslink",
    operatorCodes: ["TL"],
    // Core + one anchor per branch arm: Elstree (Midland), New Barnet
    // (ECML), St Pancras/London Bridge/Elephant & Castle/Victoria (all core
    // patterns), Dartford (North Kent), Orpington + Swanley (Catford loop
    // arms), Sutton + Wimbledon (loop), East Croydon (Brighton corridor).
    boardCrs: [
      "STP",
      "LBG",
      "EPH",
      "VIC",
      "ELS",
      "NBA",
      "DFD",
      "ORP",
      "SAY",
      "SUO",
      "WIM",
      "ECR",
    ],
    crsToStation: {
      // Midland branch
      ELS: "910GELTR",
      MIL: "910GMLHB",
      HEN: "910GHDON",
      BCZ: "910GBRENTX",
      CRI: "910GCRKLWD",
      WHP: "HUBWHD", // West Hampstead Thameslink (WHD is the Overground side)
      KTN: "HUBKTN",
      STP: "HUBKGX", // Thameslink calls at St Pancras Intl, part of our KGX hub
      // ECML branch
      FPK: "HUBFPK",
      NSG: "910GNEWSGAT",
      OKL: "910GOKLGHPK",
      NBA: "910GNBARNET",
      // Core
      ZFD: "HUBZFD",
      CTK: "910GCTMSLNK",
      BFR: "HUBBFR",
      LBG: "HUBLBG",
      EPH: "HUBEPH",
      // Victoria–Catford corridor
      VIC: "HUBVIC",
      DMK: "910GDENMRKH",
      // Catford loop + Orpington / Swanley arms
      PMR: "910GPCKHMRY",
      NHD: "910GNUNHEAD",
      CFT: "910GCFPK",
      CTF: "910GCATFORD",
      BGM: "910GBELNGHM",
      BEC: "910GBCKNHMH",
      RVB: "910GRBRN",
      SRT: "910GSHRTLND",
      BMS: "910GBROMLYS",
      BKL: "910GBICKLEY",
      PET: "910GPETSWD",
      ORP: "910GORPNGTN",
      SMY: "910GSTMRYC",
      SAY: "910GSWLY",
      // Sutton loop (western side via Wimbledon)
      LGJ: "910GLBGHJN",
      HNH: "910GHERNEH",
      TUH: "910GTULSEH",
      STE: "910GSTRETHM",
      TOO: "910GTOOTING",
      HYR: "910GHYDNSRD",
      WIM: "HUBWIM",
      WBO: "910GWIMLCHS",
      SMO: "910GSMERTON",
      MDS: "910GMORDENS",
      SIH: "910GSHLIER",
      SUC: "910GSUTTONC",
      WSU: "910GWSUTTON",
      SUO: "910GSUTTON",
      // Sutton loop (eastern side via Mitcham Junction)
      MTC: "910GESTFLDS",
      MIJ: "HUBMJT",
      HCB: "910GHKBG",
      CSH: "910GCRSHLTN",
      // Brighton main line corridor
      NWD: "HUBNWD",
      ECR: "HUBECY",
      SCY: "910GSCROYDN",
      PUR: "910GPURLEY",
      CDS: "910GCOLSDNS",
      // North Kent line via Greenwich
      DEP: "910GDEPTFD",
      GNW: "HUBGNW",
      MZH: "910GMAZEH",
      WCB: "910GWCOMBEP",
      CTN: "910GCRLN",
      WWA: "HUBWWA",
      PLU: "910GPLMS",
      ABW: "HUBABW",
      SGR: "910GSLADEGN",
      DFD: "910GDARTFD",
    },
  },
];

/** Line ids sourced from National Rail data instead of TfL Arrivals. */
export const NR_LINE_IDS: ReadonlySet<string> = new Set(
  RAIL_LINES.map((l) => l.lineId),
);
