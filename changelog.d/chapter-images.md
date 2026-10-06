### Fixed

- Chapter illustrations that a site blocks for direct loading (for example Stonescape's, which send
  Cross-Origin-Resource-Policy) showed nothing: the copy the core fetches (`cache/img-…`) is now served
  to the page, like covers.
