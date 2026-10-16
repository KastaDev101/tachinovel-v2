//
//  HeteronymTable.swift — the heteronym table Heteronyms.swift reads (JSON, so it is plain data: tests/heteronyms.test.ts
//  checks it and runs the sentence corpus against it on the PC, HeteronymsTests on CI).
//
//  To add a word: an entry under "words" with
//    variants     name → { "kokoro": Kokoro (misaki) phonemes, "pocket": a respelling Nephis's Pocket voice says right,
//                 absent = she reads the word as written for that sense },
//    kokoroSays   the variant Kokoro says by itself (misaki's DEFAULT; "kokoroSaysCapital" when a capital changes it):
//                 only the other variants are sent to Kokoro as phonemes,
//    default      the variant when no rule matches,
//    rules        in order, the first that matches wins; {"use": "<template>"} splices a shared rule list.
//  A rule's conditions (all must hold; lists may name a shared set as "@set"):
//    prev / prev2     the word before (adverbs like "already" and -ly words skipped) / the one before that;
//                     "$start" = the clause starts there (punctuation or a quote in between)
//    prevRaw          the word right before, nothing skipped
//    next / next2     the word after / the one after that; "$end" = the clause ends there
//    notPrev / notPrev2 / notNext   the opposite
//    has / hasNot     another word of the same sentence is / none is in the list
//    tense            "past" or "present": the sentence's other verbs and time words (yesterday, ago, every…)
//    tag / prevTag / nextTag   Apple's part of speech (NLTagger .lexicalClass, lowercased: noun, verb, adjective…)
//                     of the word / the word before / after; only asked when a rule gets this far
//    capital          the word has a capital away from the clause start ("Polish"); upper: a capital anywhere
//    guess            a guess (the sentence's tense): the on-device AI's sense, when it has one, wins over it
//  "$possessive" in a list matches "ship's", "Nephis's" (not "it's", "she's").
//  Phonemes: misaki's us_gold entries (tachinovel-tts-lab .venv, misaki/data/us_gold.json), the POS variants.
//  Pocket respellings checked by ear/ASR (r13, 2026-10-09): reed, tair, wynd, bau, wownd, lyve, led, leed, klohss, klohz.
//  The others (tairs, wynds, rau, dohv, sau, doze, Pohlish) follow the same spelling patterns, not yet checked on her.
//

extension Heteronyms {
    /// The built-in table (see the header).
    static let tableJSON = #"""
{
  "version": 1,
  "sets": {
    "have": ["had", "has", "have", "having", "'ve", "'d", "hadn't", "hasn't", "haven't"],
    "be": ["is", "was", "were", "are", "am", "be", "been", "being", "'re", "'m", "'s", "isn't", "wasn't", "weren't", "aren't"],
    "base": ["to", "will", "would", "can", "could", "shall", "should", "may", "might", "must", "'ll", "cannot", "do", "does", "did", "don't", "doesn't", "didn't", "won't", "wouldn't", "can't", "couldn't", "shouldn't", "mustn't", "needn't", "shan't", "let's", "please", "let", "lets"],
    "subjPl": ["i", "you", "we", "they"],
    "subj3": ["he", "she", "it", "who", "which", "one", "everyone", "everybody", "someone", "somebody", "anyone", "anybody", "nobody", "whoever"],
    "subj": ["@subjPl", "@subj3", "people"],
    "det": ["the", "a", "an", "this", "these", "those", "my", "your", "his", "her", "its", "our", "their", "no", "every", "each", "any", "some", "another", "whose", "what", "either", "neither", "much", "many", "several", "few", "other"],
    "obj": ["the", "a", "an", "this", "these", "those", "that", "my", "your", "his", "her", "its", "our", "their", "him", "them", "me", "us", "it", "you", "everything", "something", "anything", "nothing", "everyone", "someone", "anyone", "himself", "herself", "itself", "themselves", "myself", "yourself", "ourselves", "yourselves", "some", "any", "all", "both", "each", "every"],
    "pastWords": ["was", "were", "had", "did", "didn't", "wasn't", "weren't", "hadn't", "'d", "said", "went", "came", "saw", "took", "got", "made", "knew", "thought", "told", "felt", "left", "found", "gave", "stood", "sat", "ran", "began", "became", "kept", "held", "brought", "heard", "met", "paid", "wrote", "spoke", "fell", "rose", "grew", "drew", "threw", "flew", "broke", "chose", "drove", "ate", "sang", "swam", "woke", "wore", "tore", "bore", "shook", "forgot", "understood", "meant", "sent", "spent", "built", "lost", "caught", "taught", "fought", "bought", "sought", "slept", "wept", "crept", "swept", "lay", "laid", "led", "fled", "hid", "bit", "lit", "shot", "struck", "stuck", "hung", "won", "sank", "sprang", "stole", "froze", "rode", "shone", "ago", "yesterday", "earlier", "last"],
    "presentWords": ["is", "am", "are", "isn't", "aren't", "do", "does", "don't", "doesn't", "has", "hasn't", "'m", "'re", "'ll", "now", "today", "tonight", "tomorrow", "every", "always", "usually", "often", "sometimes", "nowadays", "currently", "can", "will", "won't", "can't"],
    "notPast": ["need", "seed", "feed", "speed", "bleed", "breed", "greed", "indeed", "proceed", "succeed", "exceed", "red", "bed", "shed", "wed", "sled", "embed", "hundred", "sacred", "kindred", "naked", "wicked", "ragged", "rugged", "beloved", "creed", "deed", "weed", "reed", "steed", "tweed", "shred", "hatred", "seabed", "riverbed", "bred", "sped"],
    "adverbs": ["not", "never", "already", "just", "also", "only", "ever", "even", "still", "often", "always", "sometimes", "usually", "rarely", "seldom", "once", "then", "first", "soon", "almost", "nearly", "barely", "hardly", "merely", "simply", "now"],
    "lyWords": ["reply", "apply", "supply", "imply", "comply", "rely", "belly", "jelly", "bully", "folly", "holly", "rally", "tally", "sully", "family", "italy", "assembly", "anomaly", "monopoly", "early"],
    "pronounS": ["it", "he", "she", "that", "this", "there", "here", "what", "who", "where", "how", "everyone", "someone", "nobody", "everything", "something", "nothing", "let"],
    "nearAfter": ["to", "by", "enough", "behind", "together", "call", "calls", "friend", "friends", "eye", "attention", "look", "range", "quarters", "second", "combat", "contact", "encounter", "relationship", "relationships", "relative", "relatives", "family", "ties", "shave", "proximity", "beside", "upon", "ally", "allies", "companion", "companions", "confidant", "bond", "bonds", "inspection", "examination", "scrutiny", "watch", "cousin", "cousins", "kin", "fight", "fitting", "knit", "personal", "quarter"],
    "nearBefore": ["so", "too", "very", "quite", "come", "came", "comes", "coming", "get", "got", "gets", "getting", "gotten", "drew", "draw", "draws", "drawing", "stay", "stayed", "stays", "staying", "hold", "held", "holds", "holding", "pulled", "pull", "kept", "keep", "keeps", "keeping", "stood", "stand", "standing", "sat", "sit", "sitting", "more", "as", "how", "up", "real", "pretty", "rather", "@be", "lean", "leaned", "leaning", "leant", "moved", "move", "moving", "crept", "edged", "inched", "huddled", "followed", "follow", "following", "hug", "hugged", "hugging", "clutched", "cuddled", "pressed", "lived", "live", "lives", "living", "seemed", "seems", "felt", "feels", "looked", "looks", "sounded", "sounds", "remained", "remains", "that", "this", "were", "fairly"],
    "coilPrev": ["path", "road", "river", "trail", "stream", "staircase", "stairway", "stairs", "corridor", "passage", "tunnel", "track", "vine", "vines", "snake", "rope", "hallway", "route", "creek", "lane", "street", "ivy", "queue", "procession", "column", "line", "road"],
    "coilNext": ["up", "around", "round", "through", "its", "down", "back", "along", "between", "into", "onto", "past", "toward", "towards", "among", "across", "itself", "himself", "herself", "themselves"],
    "crying": ["eye", "eyes", "cheek", "cheeks", "cry", "cried", "crying", "cries", "weep", "wept", "weeping", "sob", "sobbed", "sobbing", "sorrow", "grief", "shed", "rolled", "trickled", "glistened", "welled", "streamed", "streaked", "lashes", "eyelashes"],
    "fabric": ["fabric", "cloth", "sail", "sails", "curtain", "paper", "shirt", "sleeve", "seam", "canvas", "tent", "dress", "jeans", "pants", "trousers", "robe", "cloak", "garment", "material", "muscle", "ligament", "hamstring", "page", "stocking", "stockings", "veil", "silk", "leather", "net", "flesh", "space", "reality", "armor", "armour", "skirt", "coat", "jacket", "uniform", "glove", "map", "envelope"],
    "ripNext": ["apart", "off", "open", "through", "into", "at", "out", "away", "loose", "free", "down", "@obj"],
    "windAdj": ["cold", "icy", "chill", "chilly", "bitter", "strong", "gentle", "warm", "hot", "howling", "biting", "fierce", "north", "south", "east", "west", "northern", "southern", "eastern", "western", "evening", "morning", "night", "sea", "desert", "mountain", "autumn", "winter", "summer", "spring", "ill", "second", "trade", "solar", "stiff", "light", "high", "sudden", "steady", "dry", "cool", "salty", "fresh", "harsh", "freezing", "raging", "whistling", "rising", "passing", "prevailing", "favorable", "favourable", "fair", "foul", "east", "cutting"],
    "bowAdj": ["deep", "slight", "low", "polite", "respectful", "formal", "curt", "quick", "courtly", "stiff", "graceful", "shallow", "mocking", "exaggerated", "theatrical", "short", "perfunctory", "gracious", "sweeping", "elaborate", "humble", "proper", "final", "solemn", "brief", "awkward", "clumsy", "half", "deferential", "respectful", "elegant"],
    "bowGive": ["take", "took", "takes", "taking", "taken", "give", "gave", "gives", "giving", "given", "make", "made", "makes", "making", "swept", "sweep", "executed", "offered", "offer", "offering", "managed", "sketched", "dipped"],
    "bowWeapon": ["arrow", "arrows", "quiver", "archer", "archers", "archery", "bowstring", "string", "strings", "nock", "nocked", "notched", "aimed", "aim", "aiming", "shoot", "shot", "shooting", "fired", "longbow", "crossbow", "violin", "cello", "fiddle", "ribbon", "ribbons", "tied", "tie", "hair", "gift", "wrapped", "drew", "draw", "drawing", "strung", "unstrung", "hunt", "hunting", "hunter", "target"],
    "bendNext": ["down", "low", "before", "deeply", "slightly", "politely", "respectfully", "out", "to", "his", "her", "my", "their", "your", "our", "its", "toward", "towards", "in"],
    "ship": ["ship", "ships", "ship's", "boat", "boats", "boat's", "vessel", "deck", "hull", "stern", "port", "starboard", "prow", "keel", "mast", "aboard", "galleon", "frigate", "schooner", "yacht", "waves", "spray", "anchor"],
    "music": ["music", "song", "songs", "guitar", "guitars", "band", "play", "played", "playing", "plays", "voice", "sing", "singing", "sang", "singer", "speaker", "speakers", "beat", "beats", "drum", "drums", "note", "notes", "chord", "chords", "amp", "club", "concert", "stereo", "radio", "thumped", "thumping", "rumbled", "rumbling", "pounded", "pounding", "throbbed", "throbbing", "boomed", "booming", "dance", "dancing"],
    "fish": ["fish", "fishing", "fished", "fisherman", "fishermen", "caught", "catch", "catching", "lake", "river", "pond", "sea", "striped", "largemouth", "smallmouth", "bait", "hook", "hooked", "rod", "reel", "fillet", "fillets", "grilled", "angler", "anglers", "trout", "pike", "perch", "carp", "tackle", "lure", "lures"],
    "metal": ["metal", "metals", "poison", "poisoned", "poisoning", "toxic", "melted", "molten", "bullet", "bullets", "pencil", "pencils", "pipe", "pipes", "plumbing", "alchemy", "alchemist", "gold", "iron", "tin", "copper", "mercury", "heavy", "ingot", "ingots"],
    "metalNext": ["pipe", "pipes", "poisoning", "paint", "weight", "weights", "ball", "balls", "shot", "bullet", "bullets", "slug", "slugs", "sheet", "sheets", "sheeting", "lined", "box", "roof", "roofing", "crystal", "soldier", "soldiers", "apron", "shielding", "mine", "mines", "ore", "pencil", "pencils", "balloon", "coffin", "casket", "seal", "seals", "plate", "plating", "alloy", "fumes", "dust", "poison", "ingot", "ingots", "bar", "bars", "content", "levels"],
    "metalPrev": ["molten", "liquid", "solid", "pure", "red", "white", "sheet", "poisonous", "melted", "hot", "cold"],
    "leadRoles": ["singer", "singers", "vocals", "vocalist", "guitar", "guitarist", "role", "roles", "character", "actor", "actress", "investigator", "detective", "story", "author", "dancer", "car", "dog", "dogs", "horse", "the", "a", "an", "his", "her", "them", "him", "us", "me", "you", "it", "their", "our", "my", "your"],
    "liveThings": ["music", "wire", "wires", "broadcast", "broadcasts", "feed", "feeds", "stream", "streams", "streaming", "bait", "ammunition", "ammo", "round", "rounds", "show", "shows", "audience", "audiences", "performance", "performances", "coverage", "coal", "coals", "grenade", "grenades", "animal", "animals", "specimen", "specimens", "television", "tv", "recording", "recordings", "band", "bands", "concert", "concerts", "action", "fire", "event", "events", "video", "footage", "camera", "cameras", "chat", "update", "updates", "version", "album", "sound", "mic", "microphone", "radio", "prey", "rat", "rats", "mouse", "mice", "insects", "crabs", "lobster", "lobsters", "target", "targets", "ones", "one", "current", "electricity", "ordnance", "munitions", "explosive", "explosives", "human", "humans", "body", "bodies", "shell", "shells", "round", "theater", "theatre", "game", "games", "sacrifice", "sacrifices", "spell", "trap", "traps"],
    "liveVerbPrev": ["@base", "@subjPl", "who", "that", "people", "men", "women", "children", "folk", "folks", "humans", "creatures", "animals", "families", "long", "and", "they'd", "we'd", "i'd", "you'd", "where", "to"],
    "nounLives": ["@det", "our", "their", "many", "nine", "two", "three", "four", "five", "thousand", "thousands", "million", "millions", "hundred", "hundreds", "innocent", "human", "saving", "save", "saved", "saves", "risk", "risked", "risking", "ruin", "ruined", "ruining", "take", "took", "taken", "claimed", "cost", "costing", "change", "changed", "changing", "own", "double", "past", "private", "personal", "everyday", "daily", "real", "whole", "entire", "short", "normal", "ordinary", "busy", "quiet", "separate", "love", "sex", "social", "previous", "countless", "other", "of", "lead", "led", "leading", "leads", "live", "lived", "living", "two", "precious", "young", "new", "different"],
    "subj3Plus": ["@subj3", "family", "man", "woman", "boy", "girl", "king", "queen", "dragon", "wizard", "witch", "mother", "father", "brother", "sister", "friend", "uncle", "aunt", "grandmother", "grandfather", "beast", "creature", "monster", "god", "goddess", "hermit", "that"],
    "intens": ["so", "too", "very", "extremely", "most", "more", "quite", "rather", "incredibly", "infinitely", "relatively", "tiny", "almost", "really", "impossibly", "seemingly"],
    "tinyThings": ["detail", "details", "amount", "amounts", "trace", "traces", "particle", "particles", "difference", "differences", "change", "changes", "adjustment", "adjustments", "fragment", "fragments", "quantity", "quantities", "crack", "cracks", "movement", "movements", "flaw", "flaws", "scale", "fraction", "fractions", "portion", "portions", "crystal", "crystals", "droplet", "droplets", "hole", "holes", "opening", "gap", "gaps", "variation", "variations", "shift", "shifts", "error", "errors", "examination", "inspection", "scrutiny", "organisms", "creatures", "insects", "cut", "cuts", "scratch", "scratches", "tremor", "tremors", "speck", "specks", "grains", "bits", "pieces", "dose", "doses", "spots", "points", "lines", "letters", "print", "writing", "script"],
    "injury": ["deep", "fatal", "mortal", "open", "gaping", "bleeding", "fresh", "old", "flesh", "stab", "gunshot", "bullet", "knife", "sword", "head", "chest", "arrow", "exit", "entry", "festering", "infected", "serious", "minor", "grievous", "terrible", "horrible", "small", "large", "nasty", "ugly", "shallow", "painful", "puncture", "deadly", "bloody", "self-inflicted", "emotional", "psychic", "wide", "angry", "raw", "jagged", "clean", "the", "a", "an"],
    "coilPrevRaw": ["tightly", "tight", "loosely", "neatly", "carefully", "tautly", "spring", "springs"],
    "dived": ["into", "in", "under", "for", "off", "down", "behind", "out", "through", "toward", "towards", "after", "forward", "headfirst", "back", "beneath", "below", "deep", "deeper", "aside", "sideways", "low", "onto", "at", "across", "over", "between", "straight", "to", "from", "right", "left", "beside", "inside", "underneath", "quickly", "past"],
    "birdPrev": ["@det", "white", "grey", "gray", "mourning", "turtle", "rock", "wild", "little", "peace", "stock", "snowy", "pure", "gentle", "single", "lone"],
    "sowNext": ["the", "seeds", "seed", "discord", "doubt", "chaos", "fear", "confusion", "dissent", "panic", "terror", "mistrust", "distrust", "division", "their", "his", "her", "them", "it", "wild", "oats", "crops", "grain", "wheat", "barley", "corn", "fields", "field", "salt", "rice", "beans", "a"],
    "pigs": ["pig", "pigs", "piglet", "piglets", "boar", "hog", "hogs", "swine", "farrow", "sty", "pigsty", "litter", "grunted", "grunt", "snout", "trough", "pen", "oink", "sows"],
    "pigPrev": ["@det", "old", "fat", "breeding", "pregnant", "big", "mother", "great"],
    "nation": ["language", "people", "army", "soldiers", "soldier", "border", "government", "king", "queen", "name", "food", "vodka", "man", "woman", "men", "women", "girl", "boy", "city", "cities", "town", "village", "history", "accent", "sausage", "words", "word", "origin", "descent", "family", "immigrant", "immigrants", "poet", "writer", "composer", "friend", "friends", "culture", "and", "is", "was", "cavalry", "troops", "officer", "officers", "kingdom", "prince", "princess", "noble", "nobles"],
    "deer": ["deer", "doe", "buck", "bucks", "fawn", "fawns", "stag", "stags", "herd", "antlers", "elk", "hind", "hinds", "hunter", "hunters"],
    "deerPrev": ["the", "young", "wild", "pregnant", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twelve", "twenty", "white-tailed", "red"],
    "quarrel": ["argument", "argued", "argue", "arguing", "quarrel", "quarreled", "quarrelled", "fight", "fought", "shouting", "shouted", "yelling", "yelled", "screaming", "screamed", "bickering", "furious", "angry", "row's"],
    "lineNext": ["of", "after", "upon", "boat", "boats", "house", "houses", "hard", "harder", "faster", "ashore", "across", "away", "toward", "towards", "home", "out", "seats", "seat"],
    "linePrev": ["in", "front", "back", "first", "second", "third", "fourth", "fifth", "last", "next", "death", "skid", "every", "each", "single", "neat", "orderly", "long", "straight", "top", "bottom", "middle", "same", "this", "that", "one", "another", "whole", "entire"],
    "quarrelPrev": ["blazing", "almighty", "terrible", "family", "flaming", "furious", "noisy", "heated", "huge", "massive", "bitter", "violent", "public", "political", "diplomatic", "domestic", "awful", "dreadful", "nasty", "screaming", "shouting"],
    "contentAdjNext": ["smile", "smiles", "sigh", "sighs", "look", "expression", "feeling", "hum", "purr", "grin", "silence", "heart", "life", "mood", "soul", "sound", "murmur", "glow", "warmth", "gaze", "mind", "with", "to", "enough", "just", "simply"],
    "contentNounNext": ["of", "creator", "creators", "warning", "warnings", "moderation", "filter", "filters", "policy", "type", "types", "library", "page", "pages", "farm", "farms"],
    "linking": ["@be", "feel", "felt", "feels", "feeling", "seem", "seemed", "seems", "look", "looked", "looks", "remain", "remained", "remains", "stay", "stayed", "perfectly", "quite", "very", "more", "less", "most", "so", "fully", "completely", "entirely", "rather", "content", "seemingly", "sat", "lay", "smiled"],
    "presentAdj": ["@be", "at", "everyone", "everybody", "all", "those", "anyone", "nobody", "ever", "people", "guests", "company", "members", "persons", "witnesses", "parties", "officers"],
    "objectVerbNext": ["to"],
    "refuseNounNext": ["collector", "collectors", "collection", "heap", "heaps", "pile", "piles", "bin", "bins", "dump", "pit", "tip", "sack", "sacks", "bag", "bags", "cart", "truck", "lorry", "disposal", "workers", "of"],
    "refuseNounPrev": ["@det", "of", "household", "garden", "kitchen", "human", "rotting", "stinking", "piled", "burning", "with", "in"],
    "refuseVerbNext": ["to", "@obj", "entry", "service", "help", "food", "outright"],
    "produceNounPrev": ["@det", "fresh", "local", "farm", "organic", "seasonal", "agricultural", "dairy", "garden", "market", "of", "and", "their", "its", "rotten", "rotting", "wilted", "spoiled"],
    "produceNounNext": ["stand", "stands", "section", "aisle", "market", "markets", "department", "cart", "carts", "stall", "stalls", "sellers", "seller", "vendor", "vendors", "prices", "truck", "crate", "crates", "basket", "baskets"],
    "recordNext": ["time", "speed", "high", "highs", "low", "lows", "number", "numbers", "levels", "level", "breaking", "holder", "holders", "player", "players", "label", "labels", "store", "stores", "shop", "book", "books", "keeper", "keepers", "company", "deal", "profits", "sales", "heat", "temperature", "temperatures", "year", "attendance", "crowd", "crowds", "of", "collection"],
    "recordPrev": ["off", "on", "criminal", "police", "world", "track", "service", "public", "historical", "permanent", "written", "official", "medical", "dental", "school", "academic", "perfect", "clean", "spotless", "unbeaten", "winning", "losing", "new", "old", "broken", "for", "historic", "vinyl", "gold", "platinum", "hit", "the", "a"],
    "verbObjNext": ["@obj", "that", "how", "what", "whether", "itself", "into", "out", "on", "upon", "over"],
    "adjPrev": ["@det", "$possessive", "@be", "in", "into", "on", "at", "for", "with", "of", "very", "quite", "more", "most", "less", "so", "too", "rather", "two", "three", "several", "many", "completely", "entirely", "totally", "fairly"],
    "noonAfter": ["$end", "for", "in", "who", "and", "after", "since", "at", "with", "again", "ever", "whose", "now", "by", "confined", "chair", "chairs", "carriage", "ward", "all", "himself", "herself", "but", "or", "had", "was"],
    "invalidPrev": ["an", "the", "a", "poor", "old", "bedridden", "bedbound", "helpless", "chronic", "permanent", "frail", "complete", "total", "an"],
    "permitsVerbPrev": ["time", "weather", "circumstances", "space", "law", "budget", "condition", "conditions", "health", "schedule", "situation", "money", "funds", "@subj3"]
  },
  "templates": {
    "nounVerb": [
      { "say": "noun", "prev": ["@det", "$possessive"] },
      { "say": "verb", "prev": ["@base", "@subjPl"] },
      { "say": "verb", "prev": ["@subj"], "prev2": ["@base"] },
      { "say": "verb", "next": ["@verbObjNext"] },
      { "say": "noun", "prevTag": ["adjective", "determiner", "number"] },
      { "say": "verb", "tag": ["verb"] },
      { "say": "noun", "tag": ["noun"] }
    ],
    "nounVerbS": [
      { "say": "noun", "prev": ["@det", "$possessive", "@subjPl"] },
      { "say": "verb", "prev": ["@subj3Plus"] },
      { "say": "verb", "next": ["@verbObjNext"], "notPrev": ["$start"] },
      { "say": "noun", "prevTag": ["adjective", "determiner", "number"] },
      { "say": "verb", "tag": ["verb"] },
      { "say": "noun", "tag": ["noun"] }
    ],
    "adjVerb": [
      { "say": "adj", "prev": ["@adjPrev"] },
      { "say": "verb", "prev": ["@base", "@subjPl"] },
      { "say": "verb", "prev": ["@subj"], "prev2": ["@base"] },
      { "say": "verb", "next": ["@verbObjNext"] },
      { "say": "adj", "nextTag": ["noun"] },
      { "say": "verb", "tag": ["verb"] },
      { "say": "adj", "tag": ["adjective", "noun"] }
    ]
  },
  "words": {
    "read": {
      "kokoroSays": "reed", "default": "reed",
      "variants": { "reed": { "kokoro": "ɹˈid", "pocket": "reed" }, "red": { "kokoro": "ɹˈɛd" } },
      "rules": [
        { "say": "red", "prev": ["@have", "@be", "get", "gets", "got", "getting", "gotten", "well", "widely", "half", "un"] },
        { "say": "reed", "prev": ["@base"] },
        { "say": "red", "prev": ["@subj", "anyone", "someone", "everyone", "nobody"], "prev2": ["@have"] },
        { "say": "reed", "prev": ["@subj", "anyone", "someone", "everyone", "nobody"], "prev2": ["@base"] },
        { "say": "reed", "prev": ["$start"], "next": ["@obj", "$end", "aloud", "on", "carefully", "through", "between", "up", "out", "about", "more", "this"] },
        { "say": "reed", "prev": ["good", "great", "quick", "easy", "light", "fun", "long", "short", "enjoyable", "interesting", "entertaining", "compelling", "gripping", "fascinating", "worthwhile", "hard", "difficult", "nice", "decent", "solid", "fantastic", "wonderful", "amazing", "brilliant", "excellent", "a", "an", "the", "cold", "close", "careful", "second", "first", "fast", "slow"] },
        { "say": "red", "prev": ["sign", "signs", "note", "notes", "letter", "message", "label", "plaque", "inscription", "caption", "screen", "banner", "notice", "headline", "headlines", "card", "text", "words", "title", "display", "placard", "tablet", "page", "scroll", "message", "telegram", "entry", "line", "board", "slip", "tag"] },
        { "say": "red", "prev2": ["@det"], "prevTag": ["noun"] },
        { "say": "red", "tense": "past", "guess": true },
        { "say": "reed", "tense": "present", "guess": true },
        { "say": "red", "prev": ["@subj", "and", "then"], "guess": true },
        { "say": "red", "next": ["@obj", "through", "over", "aloud", "out", "on", "about"], "notPrev": ["$start"], "guess": true },
        { "say": "red", "prevTag": ["noun", "pronoun"], "guess": true }
      ]
    },
    "lead": {
      "kokoroSays": "leed", "default": "leed",
      "variants": { "leed": { "kokoro": "lˈid", "pocket": "leed" }, "led": { "kokoro": "lˈɛd", "pocket": "led" } },
      "rules": [
        { "say": "led", "next": ["@metalNext"] },
        { "say": "led", "prev": ["@metalPrev"] },
        { "say": "led", "prev": ["of", "with"], "notNext": ["@leadRoles"] },
        { "say": "led", "has": ["@metal"], "notPrev": ["@base", "@subj", "take", "took", "takes", "taking", "the"], "notNext": ["@leadRoles", "to"] },
        { "say": "led", "has": ["@metal"], "prev": ["the"], "next": ["in", "from", "$end", "into", "and", "was", "melted", "is", "had", "inside"] }
      ]
    },
    "live": {
      "kokoroSays": "lyve", "default": "liv",
      "variants": { "lyve": { "kokoro": "lˈIv", "pocket": "lyve" }, "liv": { "kokoro": "lˈɪv" } },
      "rules": [
        { "say": "lyve", "next": ["@liveThings"] },
        { "say": "lyve", "prev": ["went", "go", "goes", "going", "gone"] },
        { "say": "lyve", "prev": ["@be"], "next": ["$end", "on", "from", "at", "in", "now", "right", "again", "tonight", "today"], "notPrev2": ["@subjPl", "where", "how", "who", "that"] },
        { "say": "lyve", "prev": ["broadcast", "broadcasting", "aired", "airs", "streamed", "streaming", "performed", "performing", "played", "sang", "recorded", "filmed", "shown", "televised", "seen", "watched"], "next": ["$end", "on", "from", "at", "in", "to", "for"] },
        { "say": "liv", "prev": ["@liveVerbPrev"] },
        { "say": "lyve", "prev": ["@det", "$possessive"] },
        { "say": "lyve", "tag": ["adjective"] },
        { "say": "liv", "tag": ["verb"] }
      ]
    },
    "lives": {
      "kokoroSays": "lyvz", "default": "lyvz",
      "variants": { "lyvz": { "kokoro": "lˈIvz" }, "livz": { "kokoro": "lˈɪvz" } },
      "rules": [
        { "say": "lyvz", "prev": ["@nounLives", "$possessive"] },
        { "say": "livz", "prev": ["@subj3Plus"] },
        { "say": "livz", "next": ["in", "on", "at", "with", "near", "alone", "here", "there", "nearby", "next", "across", "under", "inside", "beyond", "among", "far", "by", "off", "for", "just", "upstairs", "downstairs", "abroad", "somewhere", "out"], "notPrev": ["$start"] },
        { "say": "livz", "tag": ["verb"] },
        { "say": "lyvz", "tag": ["noun"] }
      ]
    },
    "tear": {
      "kokoroSays": "teer", "default": "teer",
      "variants": { "teer": { "kokoro": "tˈɪɹ" }, "tair": { "kokoro": "tˈɛɹ", "pocket": "tair" } },
      "rules": [
        { "say": "teer", "has": ["@crying"], "prev": ["@det", "single", "lone", "solitary", "another", "one", "of", "fat", "hot", "stray", "silent", "first", "last", "happy", "few"] },
        { "say": "tair", "has": ["@fabric"], "prev": ["@det", "small", "large", "big", "long", "jagged", "ragged", "tiny", "huge", "massive", "slight"] },
        { "say": "tair", "prev": ["and"], "prev2": ["wear"] },
        { "say": "tair", "next": ["up"], "next2": ["@obj"] },
        { "say": "teer", "next": ["up"] },
        { "say": "teer", "prev": ["@det", "$possessive", "single", "lone", "solitary", "another", "stray", "fat", "first", "last"] },
        { "say": "tair", "next": ["@ripNext"] },
        { "say": "tair", "prev": ["@base", "@subjPl"] },
        { "say": "tair", "tag": ["verb"] },
        { "say": "teer", "tag": ["noun"] }
      ]
    },
    "tears": {
      "kokoroSays": "teerz", "default": "teerz",
      "variants": { "teerz": { "kokoro": "tˈɪɹz" }, "tairz": { "kokoro": "tˈɛɹz", "pocket": "tairs" } },
      "rules": [
        { "say": "teerz", "prev": ["@det", "$possessive", "in", "of", "into", "with", "without", "back", "fight", "fighting", "fought", "holding", "held", "hold", "hide", "hid", "hiding", "shed", "sheds", "shedding", "wipe", "wiped", "wiping", "happy", "hot", "fresh", "silent", "bitter", "angry", "crocodile", "more", "real", "endless", "unshed", "through", "blinked", "blinking", "and", "sweat", "blood"] },
        { "say": "tairz", "next": ["up"], "next2": ["@obj"] },
        { "say": "teerz", "next": ["up"] },
        { "say": "tairz", "prev": ["@subj3Plus", "wind", "storm", "blade", "claw", "claws", "beast", "it"] },
        { "say": "tairz", "next": ["apart", "off", "open", "into", "at", "away", "loose", "free", "@obj"], "notPrev": ["$start"] },
        { "say": "tairz", "tag": ["verb"] }
      ]
    },
    "wind": {
      "kokoroSays": "wind", "default": "wind",
      "variants": { "wind": { "kokoro": "wˈɪnd" }, "wynd": { "kokoro": "wˈInd", "pocket": "wynd" } },
      "rules": [
        { "say": "wind", "prev": ["@det", "$possessive", "@windAdj"] },
        { "say": "wynd", "next": ["up", "down", "around", "round", "back", "along", "@obj"] },
        { "say": "wynd", "prev": ["@base", "@subjPl"] },
        { "say": "wynd", "tag": ["verb"] }
      ]
    },
    "winds": {
      "kokoroSays": "windz", "default": "windz",
      "variants": { "windz": { "kokoro": "wˈɪndz" }, "wyndz": { "kokoro": "wˈIndz", "pocket": "wynds" } },
      "rules": [
        { "say": "windz", "prev": ["@det", "$possessive", "@windAdj", "four", "gale", "trade"] },
        { "say": "wyndz", "prev": ["@coilPrev", "@subj3"] },
        { "say": "wyndz", "next": ["@coilNext"], "notPrev": ["$start"] },
        { "say": "wyndz", "tag": ["verb"] }
      ]
    },
    "bow": {
      "kokoroSays": "boh", "default": "boh",
      "variants": { "boh": { "kokoro": "bˈO" }, "bau": { "kokoro": "bˈW", "pocket": "bau" } },
      "rules": [
        { "say": "bau", "prev": ["@bowAdj"] },
        { "say": "bau", "prev": ["a", "an", "his", "her", "their", "my", "another", "one", "your", "our"], "prev2": ["@bowGive"] },
        { "say": "boh", "has": ["@bowWeapon"], "notNext": ["down", "low", "deeply", "slightly", "politely", "respectfully", "before", "to"] },
        { "say": "bau", "has": ["@ship"], "prev": ["@det", "$possessive"] },
        { "say": "bau", "next": ["@bendNext"] },
        { "say": "bau", "prev": ["@base", "@subjPl", "and"] },
        { "say": "bau", "tag": ["verb"] }
      ]
    },
    "bows": {
      "kokoroSays": "bohz", "default": "bohz",
      "variants": { "bohz": { "kokoro": "bˈOz" }, "bauz": { "kokoro": "bˈWz" } },
      "rules": [
        { "say": "bohz", "has": ["@bowWeapon"], "notNext": ["down", "low", "deeply", "slightly", "politely", "respectfully", "before", "to"] },
        { "say": "bauz", "prev": ["@subj3Plus", "@bowAdj"] },
        { "say": "bauz", "next": ["down", "low", "deeply", "slightly", "politely", "respectfully", "before", "out", "his", "her", "their", "its", "to"] },
        { "say": "bauz", "tag": ["verb"] }
      ]
    },
    "close": {
      "kokoroSays": "klohs", "default": "klohs",
      "variants": { "klohs": { "kokoro": "klˈOs", "pocket": "klohss" }, "klohz": { "kokoro": "klˈOz", "pocket": "klohz" } },
      "rules": [
        { "say": "klohs", "next": ["@nearAfter"] },
        { "say": "klohz", "prev": ["a", "the"], "prev2": ["to", "toward", "towards", "near", "drew", "came", "come", "coming", "brought", "bring"] },
        { "say": "klohz", "prev": ["the"], "next": ["of"] },
        { "say": "klohz", "prev": ["@base", "@subjPl"] },
        { "say": "klohs", "prev": ["@nearBefore"] },
        { "say": "klohs", "next": ["at"], "next2": ["hand"] },
        { "say": "klohz", "next": ["@obj", "up", "down", "in", "off", "ranks", "shop", "at", "early", "late", "soon", "tomorrow", "tonight", "for"] },
        { "say": "klohs", "prev": ["it", "them", "him", "her", "me", "us", "you"] },
        { "say": "klohz", "tag": ["verb"] }
      ]
    },
    "use": {
      "kokoroSays": "yooz", "default": "yooz",
      "variants": { "yooz": { "kokoro": "jˈuz" }, "yoos": { "kokoro": "jˈus" } },
      "rules": [
        { "say": "yoos", "prev": ["to"], "prev2": ["put", "puts", "putting", "came", "come", "comes", "coming"] },
        { "say": "yoos", "prev": ["@det", "$possessive", "of", "no", "any", "much", "little", "good", "great", "full", "practical", "everyday", "daily", "common", "wide", "frequent", "constant", "excessive", "careful", "proper", "limited", "single", "regular", "personal", "free", "fair", "sole", "exclusive", "heavy", "repeated", "in", "for", "without", "make", "made", "makes", "making", "out"] },
        { "say": "yooz", "prev": ["@base", "@subj"] },
        { "say": "yooz", "next": ["@obj", "$end"] },
        { "say": "yoos", "next": ["of"] },
        { "say": "yoos", "tag": ["noun"] }
      ]
    },
    "uses": {
      "kokoroSays": "verb", "default": "noun",
      "variants": { "noun": { "kokoro": "jˈusᵻz" }, "verb": { "kokoro": "jˈuzᵻz" } },
      "rules": [{ "use": "nounVerbS" }]
    },
    "record": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "ɹˈɛkəɹd" }, "verb": { "kokoro": "ɹəkˈɔɹd" } },
      "rules": [
        { "say": "noun", "next": ["@recordNext"] },
        { "say": "noun", "prev": ["@recordPrev"] },
        { "use": "nounVerb" }
      ]
    },
    "records": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "ɹˈɛkəɹdz" }, "verb": { "kokoro": "ɹəkˈɔɹdz" } },
      "rules": [{ "say": "noun", "next": ["@recordNext"] }, { "use": "nounVerbS" }]
    },
    "present": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "pɹˈɛzᵊnt" }, "verb": { "kokoro": "pɹizˈɛnt" } },
      "rules": [
        { "say": "noun", "prev": ["@presentAdj"] },
        { "say": "verb", "next": ["itself", "himself", "herself", "themselves", "yourself", "myself", "ourselves", "arms"] },
        { "say": "noun", "next": ["day", "moment", "time", "situation", "company", "state", "tense", "age", "era", "circumstances", "world", "life", "danger", "threat", "for", "from"] },
        { "use": "nounVerb" }
      ]
    },
    "presents": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "pɹˈɛzᵊnts" }, "verb": { "kokoro": "pɹizˈɛnts" } },
      "rules": [{ "say": "verb", "next": ["itself", "himself", "herself", "themselves"] }, { "use": "nounVerbS" }]
    },
    "object": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "ˈɑbʤəkt" }, "verb": { "kokoro": "əbʤˈɛkt" } },
      "rules": [
        { "say": "noun", "prev": ["@det", "$possessive"] },
        { "say": "verb", "next": ["to", "$end"], "prev": ["@subj", "@base", "and"] },
        { "say": "verb", "next": ["to"], "notPrev": ["of", "an", "$start"] },
        { "use": "nounVerb" }
      ]
    },
    "objects": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "ˈɑbʤəkts" }, "verb": { "kokoro": "əbʤˈɛkts" } },
      "rules": [
        { "say": "noun", "prev": ["@det", "$possessive"] },
        { "say": "verb", "next": ["to", "$end"], "prev": ["@subj3Plus"] },
        { "use": "nounVerbS" }
      ]
    },
    "content": {
      "kokoroSays": "adj", "default": "adj",
      "variants": { "adj": { "kokoro": "kəntˈɛnt" }, "noun": { "kokoro": "kˈɑntɛnt" } },
      "rules": [
        { "say": "adj", "next": ["@contentAdjNext"] },
        { "say": "noun", "next": ["@contentNounNext"] },
        { "say": "adj", "prev": ["@linking"] },
        { "say": "noun", "prev": ["@det", "$possessive", "table", "digital", "online", "original", "explicit", "sexual", "violent", "graphic", "new", "fat", "sugar", "salt", "alcohol", "water", "emotional", "high", "low"] },
        { "say": "noun", "tag": ["noun"] },
        { "say": "adj", "tag": ["adjective"] }
      ]
    },
    "minute": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "mˈɪnət" }, "adj": { "kokoro": "mInˈut" } },
      "rules": [
        { "say": "adj", "prevRaw": ["@intens"] },
        { "say": "adj", "next": ["@tinyThings"] },
        { "say": "adj", "prev": ["@be"], "next": ["$end", "and", "but"] }
      ]
    },
    "wound": {
      "kokoroSays": "woond", "default": "woond",
      "variants": { "woond": { "kokoro": "wˈund" }, "wownd": { "kokoro": "wˈWnd", "pocket": "wownd" } },
      "rules": [
        { "say": "wownd", "prevRaw": ["@coilPrevRaw"] },
        { "say": "woond", "prev": ["@injury", "$possessive", "@det"] },
        { "say": "wownd", "next": ["up", "around", "round", "through", "its", "down", "tight", "tighter", "tightly", "about", "back", "along", "between", "into", "onto", "past", "toward", "towards", "among", "across", "over", "itself", "himself", "herself", "themselves", "taut"] },
        { "say": "woond", "prev": ["@base"] },
        { "say": "wownd", "prev": ["@have", "@be", "@subj", "@coilPrev"] },
        { "say": "wownd", "tag": ["verb"] }
      ]
    },
    "desert": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "dˈɛzəɹt" }, "verb": { "kokoro": "dəzˈɜɹt" } },
      "rules": [
        { "say": "noun", "next": ["island", "islands", "sand", "sands", "wind", "winds", "heat", "sun", "air", "storm", "storms", "fox", "rose", "eagle", "floor", "plains", "dunes", "dune", "nomads", "tribe", "tribes", "road", "highway", "town", "oasis", "rat", "camp", "night", "nights", "sky"] },
        { "use": "nounVerb" }
      ]
    },
    "deserts": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "dˈɛzəɹts" }, "verb": { "kokoro": "dəzˈɜɹts" } },
      "rules": [{ "say": "verb", "prevRaw": ["just"] }, { "use": "nounVerbS" }]
    },
    "refuse": {
      "kokoroSays": "verb", "default": "verb",
      "variants": { "verb": { "kokoro": "ɹəfjˈuz" }, "noun": { "kokoro": "ɹˈɛfjˌus" } },
      "rules": [
        { "say": "noun", "next": ["@refuseNounNext"], "notPrev": ["@base", "@subj"] },
        { "say": "verb", "next": ["@refuseVerbNext"] },
        { "say": "verb", "prev": ["@base", "@subj"] },
        { "say": "noun", "prev": ["@refuseNounPrev"] },
        { "say": "noun", "tag": ["noun"] }
      ]
    },
    "permit": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "pˈɜɹmɪt" }, "verb": { "kokoro": "pəɹmˈɪt" } },
      "rules": [{ "use": "nounVerb" }]
    },
    "permits": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "pˈɜɹmɪts" }, "verb": { "kokoro": "pəɹmˈɪts" } },
      "rules": [{ "say": "verb", "prev": ["@permitsVerbPrev"] }, { "use": "nounVerbS" }]
    },
    "project": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "pɹˈɑʤˌɛkt" }, "verb": { "kokoro": "pɹəʤˈɛkt" } },
      "rules": [
        { "say": "verb", "next": ["confidence", "power", "strength", "authority", "calm", "images", "onto", "outward", "outwards", "forward"] },
        { "use": "nounVerb" }
      ]
    },
    "projects": {
      "kokoroSays": "noun", "default": "noun",
      "variants": { "noun": { "kokoro": "pɹˈɑʤˌɛkts" }, "verb": { "kokoro": "pɹəʤˈɛkts" } },
      "rules": [{ "use": "nounVerbS" }]
    },
    "produce": {
      "kokoroSays": "verb", "default": "verb",
      "variants": { "verb": { "kokoro": "pɹədˈus" }, "noun": { "kokoro": "pɹˈOdˌus" } },
      "rules": [
        { "say": "noun", "next": ["@produceNounNext"] },
        { "say": "verb", "prev": ["@base", "@subj"] },
        { "say": "noun", "prev": ["@produceNounPrev", "$possessive"], "notNext": ["@obj"] },
        { "say": "verb", "next": ["@obj"] },
        { "say": "noun", "tag": ["noun"] }
      ]
    },
    "row": {
      "kokoroSays": "roh", "default": "roh",
      "variants": { "roh": { "kokoro": "ɹˈO" }, "rau": { "kokoro": "ɹˈW", "pocket": "rau" } },
      "rules": [
        { "say": "roh", "next": ["@lineNext"] },
        { "say": "roh", "prev": ["a"], "prev2": ["in"] },
        { "say": "roh", "prev": ["@linePrev"] },
        { "say": "rau", "next": ["with", "about", "over", "between", "broke", "erupted"] },
        { "say": "rau", "prev": ["@quarrelPrev"] },
        { "say": "rau", "has": ["@quarrel"], "prev": ["a", "the", "another", "their", "our", "his", "her"] }
      ]
    },
    "bass": {
      "kokoroSays": "fish", "default": "music",
      "variants": { "music": { "kokoro": "bˈAs" }, "fish": { "kokoro": "bˈæs" } },
      "rules": [
        { "say": "fish", "prev": ["striped", "largemouth", "smallmouth", "sea", "rock", "giant", "bigmouth", "black", "spotted"] },
        { "say": "fish", "has": ["@fish"], "hasNot": ["@music"] }
      ]
    },
    "dove": {
      "kokoroSays": "duv", "default": "duv",
      "variants": { "duv": { "kokoro": "dˈʌv" }, "dohv": { "kokoro": "dˈOv", "pocket": "dohv" } },
      "rules": [
        { "say": "duv", "prev": ["@birdPrev", "$possessive"] },
        { "say": "dohv", "next": ["@dived"] },
        { "say": "dohv", "prev": ["@subj", "and", "then"] },
        { "say": "dohv", "tag": ["verb"] }
      ]
    },
    "sow": {
      "kokoroSays": "soh", "default": "soh",
      "variants": { "soh": { "kokoro": "sˈO" }, "sau": { "kokoro": "sˈW", "pocket": "sau" } },
      "rules": [
        { "say": "soh", "next": ["@sowNext"], "notPrev": ["@det"] },
        { "say": "sau", "prev": ["@pigPrev", "$possessive"] },
        { "say": "soh", "prev": ["@base", "@subj"] },
        { "say": "sau", "has": ["@pigs"] }
      ]
    },
    "polish": {
      "kokoroSays": "shine", "kokoroSaysCapital": "nation", "default": "shine",
      "variants": { "shine": { "kokoro": "pˈɑlɪʃ" }, "nation": { "kokoro": "pˈOlɪʃ", "pocket": "Pohlish" } },
      "rules": [
        { "say": "nation", "capital": true },
        { "say": "shine", "prev": ["$start"], "next": ["@obj", "off", "up"] },
        { "say": "nation", "prev": ["$start"], "next": ["@nation"] },
        { "say": "nation", "prev": ["$start"], "tag": ["adjective", "noun"], "upper": true }
      ]
    },
    "separate": {
      "kokoroSays": "adj", "default": "adj",
      "variants": { "adj": { "kokoro": "sˈɛpəɹət" }, "verb": { "kokoro": "sˈɛpəɹˌAt" } },
      "rules": [{ "use": "adjVerb" }]
    },
    "estimate": {
      "kokoroSays": "verb", "default": "noun",
      "variants": { "noun": { "kokoro": "ˈɛstəmət" }, "verb": { "kokoro": "ˈɛstəmˌAt" } },
      "rules": [{ "use": "nounVerb" }]
    },
    "moderate": {
      "kokoroSays": "adj", "default": "adj",
      "variants": { "adj": { "kokoro": "mˈɑdəɹət" }, "verb": { "kokoro": "mˈɑdəɹˌAt" } },
      "rules": [{ "use": "adjVerb" }]
    },
    "invalid": {
      "kokoroSays": "adj", "default": "adj",
      "variants": { "adj": { "kokoro": "ɪnvˈælɪd" }, "noun": { "kokoro": "ˈɪnvəlɪd" } },
      "rules": [{ "say": "noun", "prev": ["@invalidPrev"], "next": ["@noonAfter"] }]
    },
    "does": {
      "kokoroSays": "duz", "default": "duz",
      "variants": { "duz": { "kokoro": "dˈʌz" }, "dohz": { "kokoro": "dˈOz", "pocket": "doze" } },
      "rules": [
        { "say": "dohz", "prev": ["@deerPrev"], "notNext": ["@obj", "not", "so", "too", "n't"] },
        { "say": "dohz", "has": ["@deer"], "prev": ["those", "these", "both", "many", "few", "several", "some", "and", "of", "its", "their", "her", "his"] }
      ]
    },
    "conduct": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "kˈɑndˌʌkt" }, "verb": { "kokoro": "kəndˈʌkt" } }, "rules": [{ "use": "nounVerb" }] },
    "conflict": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "kˈɑnflˌɪkt" }, "verb": { "kokoro": "kənflˈɪkt" } }, "rules": [{ "say": "verb", "next": ["with"], "prev": ["@subj", "@base"] }, { "use": "nounVerb" }] },
    "contract": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "kˈɑntɹˌækt" }, "verb": { "kokoro": "kəntɹˈækt" } }, "rules": [{ "use": "nounVerb" }] },
    "convert": { "kokoroSays": "verb", "default": "verb", "variants": { "verb": { "kokoro": "kənvˈɜɹt" }, "noun": { "kokoro": "kˈɑnvˌɜɹt" } }, "rules": [{ "use": "nounVerb" }] },
    "subject": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "sˈʌbʤɛkt" }, "verb": { "kokoro": "səbʤˈɛkt" } }, "rules": [{ "use": "nounVerb" }] },
    "suspect": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "sˈʌspˌɛkt" }, "verb": { "kokoro": "səspˈɛkt" } }, "rules": [{ "use": "nounVerb" }] },
    "rebel": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "ɹˈɛbᵊl" }, "verb": { "kokoro": "ɹəbˈɛl" } }, "rules": [{ "say": "verb", "next": ["against"], "notPrev": ["@det"] }, { "use": "nounVerb" }] },
    "progress": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "pɹˈɑɡɹəs" }, "verb": { "kokoro": "pɹəɡɹˈɛs" } }, "rules": [{ "say": "noun", "prev": ["make", "made", "makes", "making", "any", "no", "in", "of", "slow", "rapid", "steady", "good", "real", "little", "great"] }, { "use": "nounVerb" }] },
    "perfect": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "pˈɜɹfəkt" }, "verb": { "kokoro": "pəɹfˈɛkt" } }, "rules": [{ "say": "adj", "prev": ["@adjPrev", "picture", "near", "almost", "absolutely", "simply", "just"] }, { "say": "verb", "prev": ["@base"], "next": ["@obj"] }, { "say": "verb", "prev": ["to"] }] },
    "excuse": { "kokoroSays": "verb", "default": "verb", "variants": { "verb": { "kokoro": "ɪkskjˈuz" }, "noun": { "kokoro": "ɪkskjˈus" } }, "rules": [{ "say": "noun", "prev": ["@det", "$possessive", "good", "poor", "lame", "perfect", "convenient", "weak", "flimsy", "valid", "no", "any", "an", "as", "for"] }, { "say": "verb", "next": ["@obj"] }, { "use": "nounVerb" }] },
    "abuse": { "kokoroSays": "verb", "default": "noun", "variants": { "verb": { "kokoro": "əbjˈuz" }, "noun": { "kokoro": "əbjˈus" } }, "rules": [{ "say": "noun", "prev": ["of", "verbal", "physical", "emotional", "sexual", "child", "drug", "alcohol", "substance", "domestic", "years", "suffered", "endured", "the", "from"] }, { "use": "nounVerb" }] },
    "insult": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "ˈɪnsˌʌlt" }, "verb": { "kokoro": "ɪnsˈʌlt" } }, "rules": [{ "use": "nounVerb" }] },
    "increase": { "kokoroSays": "verb", "default": "verb", "variants": { "verb": { "kokoro": "ɪnkɹˈis" }, "noun": { "kokoro": "ˈɪnkɹˌis" } }, "rules": [{ "say": "noun", "next": ["in", "of"], "notPrev": ["@base", "@subj"] }, { "use": "nounVerb" }] },
    "decrease": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "dˈikɹˌis" }, "verb": { "kokoro": "dəkɹˈis" } }, "rules": [{ "say": "noun", "next": ["in", "of"], "notPrev": ["@base", "@subj"] }, { "use": "nounVerb" }] },
    "torment": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "tˈɔɹmˌɛnt" }, "verb": { "kokoro": "tɔɹmˈɛnt" } }, "rules": [{ "use": "nounVerb" }] },
    "contest": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "kˈɑntˌɛst" }, "verb": { "kokoro": "kəntˈɛst" } }, "rules": [{ "use": "nounVerb" }] },
    "console": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "kˈɑnsˌOl" }, "verb": { "kokoro": "kənsˈOl" } }, "rules": [{ "use": "nounVerb" }] },
    "entrance": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "ˈɛntɹəns" }, "verb": { "kokoro": "ɪntɹˈæns" } }, "rules": [{ "say": "noun", "prev": ["@det", "$possessive", "main", "front", "back", "side", "secret", "hidden", "grand", "rear", "cave", "tunnel", "dungeon", "her", "his", "an", "the", "dramatic", "its", "made"] }, { "say": "verb", "prev": ["@base"], "next": ["@obj"] }] },
    "compound": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "kˈɑmpˌWnd" }, "verb": { "kokoro": "kəmpˈWnd" } }, "rules": [{ "use": "nounVerb" }] },
    "survey": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "sˈɜɹvˌA" }, "verb": { "kokoro": "səɹvˈA" } }, "rules": [{ "use": "nounVerb" }] },
    "reject": { "kokoroSays": "verb", "default": "verb", "variants": { "verb": { "kokoro": "ɹəʤˈɛkt" }, "noun": { "kokoro": "ɹˈiʤˌɛkt" } }, "rules": [{ "say": "noun", "prev": ["@det", "$possessive", "social", "total", "complete"] }, { "use": "nounVerb" }] },
    "attribute": { "kokoroSays": "noun", "default": "noun", "variants": { "noun": { "kokoro": "ˈætɹəbjˌut" }, "verb": { "kokoro": "ətɹˈɪbjˌut" } }, "rules": [{ "use": "nounVerb" }] },
    "alternate": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "ˈɔltəɹnət" }, "verb": { "kokoro": "ˈɔltəɹnˌAt" } }, "rules": [{ "say": "verb", "next": ["between", "with"] }, { "use": "adjVerb" }] },
    "associate": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "əsˈOsiət" }, "verb": { "kokoro": "əsˈOsiˌAt" } }, "rules": [{ "say": "verb", "next": ["with"] }, { "use": "adjVerb" }] },
    "graduate": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "ɡɹˈæʤəwət" }, "verb": { "kokoro": "ɡɹˈæʤʊˌAt" } }, "rules": [{ "say": "verb", "next": ["from", "with", "in", "high", "college", "school"], "notPrev": ["@det", "$possessive"] }, { "use": "adjVerb" }] },
    "appropriate": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "əpɹˈOpɹiət" }, "verb": { "kokoro": "əpɹˈOpɹiˌAt" } }, "rules": [{ "use": "adjVerb" }] },
    "deliberate": { "kokoroSays": "verb", "default": "adj", "variants": { "adj": { "kokoro": "dəlˈɪbəɹət" }, "verb": { "kokoro": "dəlˈɪbəɹˌAt" } }, "rules": [{ "use": "adjVerb" }] },
    "elaborate": { "kokoroSays": "verb", "default": "adj", "variants": { "adj": { "kokoro": "əlˈæbəɹət" }, "verb": { "kokoro": "əlˈæbəɹˌAt" } }, "rules": [{ "use": "adjVerb" }] },
    "intimate": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "ˈɪntəmət" }, "verb": { "kokoro": "ˈɪntəmˌAt" } }, "rules": [{ "use": "adjVerb" }] },
    "advocate": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "ˈædvəkət" }, "verb": { "kokoro": "ˈædvəkˌAt" } }, "rules": [{ "say": "verb", "next": ["for"], "prev": ["@base", "@subj"] }, { "use": "adjVerb" }] },
    "duplicate": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "dˈupləkət" }, "verb": { "kokoro": "dˈupləkˌAt" } }, "rules": [{ "use": "adjVerb" }] },
    "approximate": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "əpɹˈɑksəmət" }, "verb": { "kokoro": "əpɹˈɑksəmˌAt" } }, "rules": [{ "use": "adjVerb" }] },
    "articulate": { "kokoroSays": "adj", "default": "adj", "variants": { "adj": { "kokoro": "ɑɹtˈɪkjələt" }, "verb": { "kokoro": "ɑɹtˈɪkjəlˌAt" } }, "rules": [{ "use": "adjVerb" }] }
  }
}
"""#
}
