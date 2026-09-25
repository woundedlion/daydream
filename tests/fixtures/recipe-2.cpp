/**
 * @brief Builds the truncatedIcosidodecahedron_hankin62_chamfer50_dual star
 * pattern (V=0, F=0, I=0).
 * @param a Output arena for the result and even pipeline stages.
 * @param b Scratch arena for odd pipeline stages.
 * @return The resulting star-pattern mesh.
 */
FLASHMEM static PolyMesh
truncatedIcosidodecahedron_hankin62_chamfer50_dual(Arena &a, Arena &b) {
  return SolidBuilder(
             IslamicStarPatterns::truncatedIcosidodecahedron_hankin62_chamfer50(
                 a, b),
             a, b)
      .dual()
      .build();
}
