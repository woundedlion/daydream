/**
 * @brief Builds the truncated_icosahedron_hk58_chamfer63 star pattern (V=1200,
 * F=602, I=3600).
 * @param a First arena in the alternating construction pair.
 * @param b Second arena; the result may borrow storage from either arena.
 * @return The resulting star-pattern mesh.
 */
FLASHMEM static PolyMesh truncated_icosahedron_hk58_chamfer63(Arena &a,
                                                              Arena &b) {
  return SolidBuilder(Archimedean::truncated_icosahedron(a, b), a, b)
      .hankin(58.0f * D2R)
      .chamfer(0.63f)
      .build();
}
