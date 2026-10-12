/**
 * @brief Builds the truncated_icosahedron_hk58_chamfer63_kis star pattern (V=0,
 * F=0, I=0).
 * @param a First arena in the alternating construction pair.
 * @param b Second arena; the result may borrow storage from either arena.
 * @return The resulting star-pattern mesh.
 */
FLASHMEM static PolyMesh truncated_icosahedron_hk58_chamfer63_kis(Arena &a,
                                                                  Arena &b) {
  return SolidBuilder(
             IslamicStarPatterns::truncated_icosahedron_hk58_chamfer63(a, b), a,
             b)
      .kis()
      .build();
}
