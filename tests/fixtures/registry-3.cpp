/** Step table for icosahedron_kis_gyro_hk54. */
inline constexpr OpStep ICOSAHEDRON_KIS_GYRO_HK54_STEPS[] = {
    {Op::KIS},
    {Op::GYRO},
    {Op::HANKIN, 54.0f * IslamicStarPatterns::D2R},
};
/** Recipe mirror of IslamicStarPatterns::icosahedron_kis_gyro_hk54. */
inline constexpr Recipe ICOSAHEDRON_KIS_GYRO_HK54_RECIPE =
    make_recipe(SEED_ICOSAHEDRON, ICOSAHEDRON_KIS_GYRO_HK54_STEPS);

// Append this Entry to islamic_registry and raise ISLAMIC_COUNT by one.
// Until they agree, its size static_assert and the NUM_ENTRIES sum both
// fail; the README registry table counts the entry too.
    {"icosahedron_kis_gyro_hk54",
     IslamicStarPatterns::icosahedron_kis_gyro_hk54, Category::Complex,
     &ICOSAHEDRON_KIS_GYRO_HK54_RECIPE},
