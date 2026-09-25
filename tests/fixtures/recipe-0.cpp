/**
 * @brief Builds the dodecahedron_hk62_ambo_hk62_kis star pattern (V=0, F=0,
 * I=0).
 * @param a Output arena for the result and even pipeline stages.
 * @param b Scratch arena for odd pipeline stages.
 * @return The resulting star-pattern mesh.
 */
FLASHMEM static PolyMesh dodecahedron_hk62_ambo_hk62_kis(Arena &a, Arena &b) {
  return SolidBuilder(IslamicStarPatterns::dodecahedron_hk62_ambo_hk62(a, b), a,
                      b)
      .kis()
      .build();
}
