### Fixed

- Car player: the list of novels jumped back to the top every second while it was open (the state poll
  rebuilt the whole player), so novels further down couldn't be reached, and a tap during a rebuild could
  be lost. The poll now only updates what changed. Found by the UI crawler.
