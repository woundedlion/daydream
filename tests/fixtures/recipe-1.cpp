/**
 * @brief Builds the truncatedIcosidodecahedron_hk62_ambo_hk62_kis star pattern
 * (V=0, F=0, I=0).
 * @param a Output arena for the result and even pipeline stages.
 * @param b Scratch arena for odd pipeline stages.
 * @return The resulting star-pattern mesh.
 */
FLASHMEM static PolyMesh
truncatedIcosidodecahedron_hk62_ambo_hk62_kis(Arena &a, Arena &b) {
  return SolidBuilder(
             IslamicStarPatterns::truncatedIcosidodecahedron_hk62_ambo_hk62(a,
                                                                            b),
             a, b)
      .kis()
      .build();
}
