/**
 * @brief Builds the truncatedIcosahedron_ambo_relax_truncate001_hankin59_kis
 * star pattern (V=0, F=0, I=0).
 * @param a First arena in the alternating construction pair.
 * @param b Second arena; the result may borrow storage from either arena.
 * @return The resulting star-pattern mesh.
 */
FLASHMEM static PolyMesh
truncatedIcosahedron_ambo_relax_truncate001_hankin59_kis(Arena &a, Arena &b) {
  return SolidBuilder(
             IslamicStarPatterns::
                 truncatedIcosahedron_ambo_relax_truncate001_hankin59(a, b),
             a, b)
      .kis()
      .build();
}
