/**
 * @brief Builds the truncated_icosidodecahedron_hankin62_chamfer50_dual star
 * pattern (V=0, F=0, I=0).
 * @param a First arena in the alternating construction pair.
 * @param b Second arena; the result may borrow storage from either arena.
 * @return The resulting star-pattern mesh.
 */
HS_FLASH_INLINE inline PolyMesh
truncated_icosidodecahedron_hankin62_chamfer50_dual(Arena &a, Arena &b) {
  return SolidBuilder(IslamicStarPatterns::
                          truncated_icosidodecahedron_hankin62_chamfer50(a, b),
                      a, b)
      .dual()
      .build();
}
