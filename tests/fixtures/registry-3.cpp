// clang-format off
/** Step table for icosahedron_kis_gyro_hk54. */
inline constexpr OpStep ICOSAHEDRON_KIS_GYRO_HK54_STEPS[] = {
    {Op::KIS},
    {Op::GYRO},
    {Op::HANKIN, 54.0f * IslamicStarPatterns::D2R},
};
// clang-format on
/** Recipe mirror of IslamicStarPatterns::icosahedron_kis_gyro_hk54. */
inline constexpr Recipe ICOSAHEDRON_KIS_GYRO_HK54_RECIPE =
    make_recipe(SEED_ICOSAHEDRON, ICOSAHEDRON_KIS_GYRO_HK54_STEPS);

// Append this Entry to islamic_registry.
    {"icosahedron_kis_gyro_hk54",
     IslamicStarPatterns::icosahedron_kis_gyro_hk54, Category::COMPLEX,
     &ICOSAHEDRON_KIS_GYRO_HK54_RECIPE},
