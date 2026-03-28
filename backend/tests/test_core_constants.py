import unittest
import backend.core_constants as constants

class TestCoreConstants(unittest.TestCase):
    def test_constants_values(self):
        self.assertEqual(constants.LDU_TO_METERS, 0.0004)
        self.assertEqual(constants.METERS_TO_LDU, 2500.0)
        self.assertEqual(constants.LEGO_GRID_LDU, 20.0)
        self.assertEqual(constants.HALF_GRID_LDU, 10.0)
        self.assertEqual(constants.LEGO_GRID_METERS, 0.008)
        self.assertEqual(constants.HALF_GRID_METERS, 0.004)
        self.assertEqual(constants.LDU, 0.0004)
        self.assertEqual(constants.LDU_TO_SI, 0.0004)

if __name__ == '__main__':
    unittest.main()
