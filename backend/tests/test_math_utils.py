import unittest
import numpy as np
from backend.math_utils import CoordinateTransformer, purify_rotation_matrix, purify_matrix, matrix_to_list

class TestMathUtils(unittest.TestCase):
    def test_get_rx180(self):
        mat = CoordinateTransformer.get_rx180()
        expected = np.array([[1, 0, 0], [0, -1, 0], [0, 0, -1]], dtype=np.float64)
        np.testing.assert_array_equal(mat, expected)

    def test_normalize_pos(self):
        pos_ldu = np.array([10, -20, 30])
        pos_si = CoordinateTransformer.normalize_pos(pos_ldu)
        # Rx180 @ [10, -20, 30] -> [10, 20, -30]
        # SI = [10, 20, -30] * 0.0004 = [0.004, 0.008, -0.012]
        expected = np.array([0.004, 0.008, -0.012])
        np.testing.assert_allclose(pos_si, expected)

    def test_normalize_rot(self):
        rot_ldu = np.array([
            [0, 1, 0],
            [-1, 0, 0],
            [0, 0, 1]
        ])
        rot_si = CoordinateTransformer.normalize_rot(rot_ldu)
        rx180 = CoordinateTransformer.get_rx180()
        expected = rx180 @ rot_ldu @ rx180
        np.testing.assert_allclose(rot_si, expected)

    def test_purify_rotation_matrix_with_zero_vectors(self):
        mat = np.zeros((3, 3))
        res = purify_rotation_matrix(mat)
        np.testing.assert_allclose(res, np.eye(3))

    def test_purify_rotation_matrix_aliases(self):
        mat = np.array([
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
        ])
        res1 = purify_matrix(mat)
        res2 = purify_rotation_matrix(mat)
        res3 = CoordinateTransformer.purify_matrix(mat)
        np.testing.assert_allclose(res1, np.eye(3))
        np.testing.assert_allclose(res2, np.eye(3))
        np.testing.assert_allclose(res3, np.eye(3))

    def test_matrix_to_list(self):
        mat = np.array([[1, 2], [3, 4]])
        self.assertEqual(matrix_to_list(mat), [[1, 2], [3, 4]])

if __name__ == '__main__':
    unittest.main()
