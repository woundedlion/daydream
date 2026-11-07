/**
 * @brief Builds the truncated_icosahedron_ambo_relax_truncate001_hankin59_kis
 * star pattern.
 * @param a First arena in the alternating construction pair.
 * @param b Second arena; the result may borrow storage from either arena.
 * @return The resulting star-pattern mesh.
 */
HS_FLASH_INLINE inline PolyMesh
truncated_icosahedron_ambo_relax_truncate001_hankin59_kis(Arena &a, Arena &b) {
  return SolidBuilder(
             IslamicStarPatterns::
                 truncated_icosahedron_ambo_relax_truncate001_hankin59(a, b),
             a, b)
      .kis()
      .build();
}
