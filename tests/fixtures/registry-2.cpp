// clang-format off
/** Step table for truncated_icosahedron_ambo_relax100_truncate01_hk59. */
inline constexpr OpStep
    TRUNCATED_ICOSAHEDRON_AMBO_RELAX100_TRUNCATE01_HK59_STEPS[] = {
        {Op::AMBO},
        {Op::RELAX, 100.0f},
        {Op::TRUNCATE, 0.01f},
        {Op::HANKIN, 59.0f * IslamicStarPatterns::D2R},
};
// clang-format on
/**
 * Recipe mirror of
 * IslamicStarPatterns::truncated_icosahedron_ambo_relax100_truncate01_hk59.
 */
inline constexpr Recipe
    TRUNCATED_ICOSAHEDRON_AMBO_RELAX100_TRUNCATE01_HK59_RECIPE =
        make_recipe(SEED_TRUNCATED_ICOSAHEDRON,
                    TRUNCATED_ICOSAHEDRON_AMBO_RELAX100_TRUNCATE01_HK59_STEPS);

// Append this Entry to islamic_registry.
    {"truncatedIcosahedron_ambo_relax100_truncate01_hk59",
     IslamicStarPatterns::truncated_icosahedron_ambo_relax100_truncate01_hk59,
     Category::COMPLEX,
     &TRUNCATED_ICOSAHEDRON_AMBO_RELAX100_TRUNCATE01_HK59_RECIPE},
