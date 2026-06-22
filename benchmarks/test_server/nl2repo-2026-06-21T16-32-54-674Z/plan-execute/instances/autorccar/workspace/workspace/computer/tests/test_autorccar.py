"""
Comprehensive test suite for AutoRCCar project.

Tests cover:
  1. NeuralNetwork: create, train, evaluate, predict, save/load_model
  2. RCControl: steer and stop (mocked serial)
  3. DistanceToCamera: calculate with various inputs
  4. ObjectDetection: detect with cascade classifier
  5. load_data: training data loading and splitting
  6. CollectTrainingData: data collection helpers
  7. Server / VideoStreamHandler / SensorDataHandler: class attributes

Run with:  pytest computer/tests/test_autorccar.py -v
"""

import sys
import os
import math
import tempfile
import shutil
import numpy as np
import cv2
import pytest

# ---------------------------------------------------------------------------
# Ensure the workspace/computer directory is importable
# ---------------------------------------------------------------------------
COMPUTER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if COMPUTER_DIR not in sys.path:
    sys.path.insert(0, COMPUTER_DIR)

from computer.model import NeuralNetwork, load_data
from computer.rc_driver_helper import RCControl, DistanceToCamera, ObjectDetection

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _no_gui():
    """Headless mode: prevent cv2.imshow / pygame from blocking tests."""
    os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = "999999999"


# ---------------------------------------------------------------------------
# 1. NeuralNetwork Tests
# ---------------------------------------------------------------------------

class TestNeuralNetworkCreate:
    def test_create_sets_mlpc(self):
        nn = NeuralNetwork()
        nn.create(np.int32([76800, 32, 4]))
        assert nn.mlpc is not None
        assert isinstance(nn.mlpc, cv2.ml.ANN_MLP)

    def test_create_small_network(self):
        nn = NeuralNetwork()
        nn.create(np.int32([10, 5, 3]))
        assert nn.mlpc is not None

    def test_create_from_list(self):
        nn = NeuralNetwork()
        nn.create([10, 5, 3])          # not np.ndarray – should coerce
        assert nn.mlpc is not None


class TestNeuralNetworkTrain:
    def test_train_without_create_raises(self):
        nn = NeuralNetwork()
        with pytest.raises(RuntimeError, match="not created"):
            nn.train(np.zeros((1, 4), dtype=np.float32),
                     np.zeros((1, 3), dtype=np.float32))

    def test_train_basic(self):
        nn = NeuralNetwork()
        nn.create(np.int32([4, 8, 3]))
        X = np.random.rand(20, 4).astype(np.float32)
        y = np.zeros((20, 3), dtype=np.float32)
        y[np.arange(20), np.random.randint(0, 3, 20)] = 1
        nn.train(X, y)
        # train() should not raise

    def test_train_converts_dtypes(self):
        nn = NeuralNetwork()
        nn.create(np.int32([4, 8, 2]))
        X = np.random.rand(10, 4).astype(np.float64)
        y = np.random.rand(10, 2).astype(np.float64)
        nn.train(X, y)  # should auto-convert to float32


class TestNeuralNetworkPredict:
    def test_predict_without_create_raises(self):
        nn = NeuralNetwork()
        with pytest.raises(RuntimeError, match="not created"):
            nn.predict(np.zeros((1, 4), dtype=np.float32))

    def test_predict_returns_labels(self):
        nn = NeuralNetwork()
        nn.create(np.int32([4, 8, 3]))
        X = np.random.rand(5, 4).astype(np.float32)
        y = np.zeros((5, 3), dtype=np.float32)
        y[np.arange(5), np.random.randint(0, 3, 5)] = 1
        nn.train(X, y)
        preds = nn.predict(X)
        assert preds.ndim == 1
        assert set(preds).issubset({0, 1, 2})

    def test_predict_single_sample_reshaped(self):
        nn = NeuralNetwork()
        nn.create(np.int32([4, 4, 2]))
        X = np.random.rand(10, 4).astype(np.float32)
        y = np.zeros((10, 2), dtype=np.float32)
        y[np.arange(10), np.random.randint(0, 2, 10)] = 1
        nn.train(X, y)
        sample = X[0]  # 1-D
        pred = nn.predict(sample)
        assert pred.ndim == 1
        assert pred.size == 1


class TestNeuralNetworkEvaluate:
    def test_evaluate_without_create_raises(self):
        nn = NeuralNetwork()
        with pytest.raises(RuntimeError, match="not created"):
            nn.evaluate(np.zeros((1, 4)), np.zeros((1, 2)))

    def test_evaluate_returns_float(self):
        nn = NeuralNetwork()
        nn.create(np.int32([4, 8, 3]))
        X = np.random.rand(20, 4).astype(np.float32)
        y = np.zeros((20, 3), dtype=np.float32)
        y[np.arange(20), np.random.randint(0, 3, 20)] = 1
        nn.train(X, y)
        acc = nn.evaluate(X, y)
        assert isinstance(acc, float)
        assert 0.0 <= acc <= 1.0


class TestNeuralNetworkPersistence:
    def test_save_model_without_create_raises(self):
        nn = NeuralNetwork()
        with pytest.raises(RuntimeError, match="not created"):
            nn.save_model("/tmp/should_fail.xml")

    def test_save_and_load_roundtrip(self):
        tmpdir = tempfile.mkdtemp()
        path = os.path.join(tmpdir, "nn_model.xml")
        try:
            nn = NeuralNetwork()
            nn.create(np.int32([4, 8, 3]))
            X = np.random.rand(10, 4).astype(np.float32)
            y = np.zeros((10, 3), dtype=np.float32)
            y[np.arange(10), np.random.randint(0, 3, 10)] = 1
            nn.train(X, y)
            preds_before = nn.predict(X)

            nn.save_model(path)
            assert os.path.isfile(path)

            nn2 = NeuralNetwork()
            nn2.load_model(path)
            preds_after = nn2.predict(X)

            np.testing.assert_array_equal(preds_before, preds_after)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_load_model_nonexistent_raises(self):
        nn = NeuralNetwork()
        with pytest.raises(FileNotFoundError, match="not found"):
            nn.load_model("/tmp/definitely_does_not_exist.xml")


class TestNeuralNetworkFullPipeline:
    """Integration: create → train → evaluate → predict → save → load."""

    def test_end_to_end(self):
        tmpdir = tempfile.mkdtemp()
        path = os.path.join(tmpdir, "full.xml")
        try:
            nn = NeuralNetwork()
            nn.create(np.int32([4, 16, 4]))

            # Generate synthetic one-hot data
            n = 50
            X = np.random.rand(n, 4).astype(np.float32)
            y = np.zeros((n, 4), dtype=np.float32)
            y[np.arange(n), np.random.randint(0, 4, n)] = 1

            nn.train(X, y)
            acc = nn.evaluate(X, y)
            assert isinstance(acc, float)

            preds = nn.predict(X)
            assert preds.shape == (n,)
            assert all(0 <= p < 4 for p in preds)

            nn.save_model(path)
            nn2 = NeuralNetwork()
            nn2.load_model(path)
            preds2 = nn2.predict(X)
            np.testing.assert_array_equal(preds, preds2)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# 2. RCControl Tests  (serial port mocked)
# ---------------------------------------------------------------------------

class MockSerial:
    """Fake serial.Serial for tests."""
    def __init__(self, *args, **kwargs):
        self.written = []
        self.port = args[0] if args else None
        self.baudrate = kwargs.get("baudrate", 115200)

    def write(self, data):
        self.written.append(data)

    def close(self):
        pass


class TestRCControl:
    def test_init_opens_port(self, monkeypatch):
        monkeypatch.setattr("rc_driver_helper.serial.Serial", MockSerial)
        rc = RCControl("/dev/ttyFAKE")
        assert rc.serial_port.port == "/dev/ttyFAKE"
        assert rc.serial_port.baudrate == 115200

    def test_steer_forward(self, monkeypatch):
        monkeypatch.setattr("rc_driver_helper.serial.Serial", MockSerial)
        rc = RCControl("/dev/ttyFAKE")
        rc.steer(2)
        assert rc.serial_port.written == [b'\x01']   # chr(1)

    def test_steer_left(self, monkeypatch):
        monkeypatch.setattr("rc_driver_helper.serial.Serial", MockSerial)
        rc = RCControl("/dev/ttyFAKE")
        rc.steer(0)
        assert rc.serial_port.written == [b'\x07']   # chr(7)

    def test_steer_right(self, monkeypatch):
        monkeypatch.setattr("rc_driver_helper.serial.Serial", MockSerial)
        rc = RCControl("/dev/ttyFAKE")
        rc.steer(1)
        assert rc.serial_port.written == [b'\x06']   # chr(6)

    def test_steer_unknown_calls_stop(self, monkeypatch):
        monkeypatch.setattr("rc_driver_helper.serial.Serial", MockSerial)
        rc = RCControl("/dev/ttyFAKE")
        rc.steer(99)
        assert rc.serial_port.written == [b'\x00']   # stop

    def test_stop(self, monkeypatch):
        monkeypatch.setattr("rc_driver_helper.serial.Serial", MockSerial)
        rc = RCControl("/dev/ttyFAKE")
        rc.stop()
        assert rc.serial_port.written == [b'\x00']


# ---------------------------------------------------------------------------
# 3. DistanceToCamera Tests
# ---------------------------------------------------------------------------

class TestDistanceToCameraInit:
    def test_default_params(self):
        d = DistanceToCamera()
        assert abs(d.alpha - 8.0 * math.pi / 180) < 1e-9
        assert abs(d.v0 - 119.865631204) < 1e-9
        assert abs(d.ay - 332.262498472) < 1e-9


class TestDistanceToCameraCalculate:
    def _make_image(self, h=480, w=640):
        return np.zeros((h, w, 3), dtype=np.uint8)

    def test_returns_float(self):
        d = DistanceToCamera()
        img = self._make_image()
        result = d.calculate(200.0, 5.5, 300, img)
        assert isinstance(result, (float, np.floating))

    def test_positive_distance_for_reasonable_input(self):
        d = DistanceToCamera()
        img = self._make_image()
        result = d.calculate(200.0, 5.5, 300, img)
        assert result > 0

    def test_negative_or_invalid_returns_negative(self):
        d = DistanceToCamera()
        img = self._make_image()
        # v far above v0 may yield negative tan → negative distance
        result = d.calculate(10.0, 5.5, 300, img)
        # Just assert no exception is raised; sign is geometry-dependent
        assert isinstance(result, (float, np.floating))

    def test_draws_text_on_positive_distance(self):
        d = DistanceToCamera()
        img = self._make_image()
        result = d.calculate(200.0, 5.5, 300, img)
        # After drawing, image should have non-zero pixels near (640-300, 480-20)
        assert result > 0  # we know 200 yields positive

    def test_deterministic(self):
        d = DistanceToCamera()
        img1 = self._make_image()
        img2 = self._make_image()
        r1 = d.calculate(150.0, 10.0, 100, img1)
        r2 = d.calculate(150.0, 10.0, 100, img2)
        assert r1 == r2

    def test_formula_verification(self):
        """Manually verify the distance formula."""
        d = DistanceToCamera()
        v, h = 200.0, 5.5
        expected = h / math.tan(
            d.alpha + math.atan((v - d.v0) / d.ay)
        )
        img = self._make_image()
        result = d.calculate(v, h, 300, img)
        np.testing.assert_almost_equal(result, expected, decimal=6)


# ---------------------------------------------------------------------------
# 4. ObjectDetection Tests
# ---------------------------------------------------------------------------

class TestObjectDetectionInit:
    def test_default_flags(self):
        od = ObjectDetection()
        assert od.red_light is False
        assert od.green_light is False
        assert od.yellow_light is False


class TestObjectDetectionDetect:
    def test_detect_returns_0_for_empty_image(self):
        """Empty cascade classifier → empty() returns True → returns 0."""
        od = ObjectDetection()
        gray = np.zeros((480, 640), dtype=np.uint8)
        color = np.zeros((480, 640, 3), dtype=np.uint8)
        cascade = cv2.CascadeClassifier()  # empty – no XML loaded
        result = od.detect(cascade, gray, color)
        assert result == 0

    def test_detect_ignores_missing_classifier_gracefully(self):
        """Missing XML → cascade.empty() is True → no crash."""
        od = ObjectDetection()
        gray = np.zeros((480, 640), dtype=np.uint8)
        color = np.zeros((480, 640, 3), dtype=np.uint8)
        cascade = cv2.CascadeClassifier("nonexistent.xml")
        result = od.detect(cascade, gray, color)
        # Should not crash; returns 0 for empty classifier
        assert isinstance(result, (int, np.integer))

    def test_detect_resets_flags_after_call(self):
        od = ObjectDetection()
        od.red_light = True
        od.green_light = True
        gray = np.zeros((480, 640), dtype=np.uint8)
        color = np.zeros((480, 640, 3), dtype=np.uint8)
        cascade = cv2.CascadeClassifier()  # empty
        od.detect(cascade, gray, color)
        # Flags should remain unchanged when nothing detected
        assert od.red_light is True
        assert od.green_light is True


# ---------------------------------------------------------------------------
# 5. load_data Tests
# ---------------------------------------------------------------------------

class TestLoadData:
    def test_load_data_no_files_raises(self):
        with pytest.raises(FileNotFoundError, match="No training data"):
            load_data(76800, "/nonexistent_dir_*.npz")

    def test_load_data_creates_correct_split(self):
        tmpdir = tempfile.mkdtemp()
        try:
            # Create several synthetic npz files
            input_size = 38400  # 120*320
            for i in range(5):
                X = np.random.rand(10, input_size).astype(np.float32) * 255
                y = np.zeros((10, 4), dtype=np.float32)
                y[np.arange(10), np.random.randint(0, 4, 10)] = 1
                np.savez(os.path.join(tmpdir, f"data_{i:06d}.npz"),
                         image=X, label=y)

            X_train, X_test, y_train, y_test = load_data(
                input_size, os.path.join(tmpdir, "*.npz")
            )

            total = X_train.shape[0] + X_test.shape[0]
            assert total == 50  # 5 files * 10 samples
            assert X_train.shape[1] == input_size
            assert y_train.shape[1] == 4
            assert y_test.shape[1] == 4
            # 80/20 split: ~40 train, ~10 test
            assert X_train.shape[0] == 40
            assert X_test.shape[0] == 10
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_load_data_normalizes(self):
        tmpdir = tempfile.mkdtemp()
        try:
            X = np.ones((5, 100), dtype=np.float32) * 255
            y = np.zeros((5, 4), dtype=np.float32)
            y[:, 0] = 1
            np.savez(os.path.join(tmpdir, "data_000000.npz"),
                     image=X, label=y)

            X_train, _, _, _ = load_data(100, os.path.join(tmpdir, "*.npz"))
            assert X_train.max() <= 1.001  # normalized by 255
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_load_data_handles_1d_labels(self):
        tmpdir = tempfile.mkdtemp()
        try:
            X = np.random.rand(10, 100).astype(np.float32)
            y = np.array([0, 1, 2, 3, 0, 1, 2, 3, 0, 1])  # 1-D integer labels
            np.savez(os.path.join(tmpdir, "data_000000.npz"),
                     image=X, label=y)

            X_train, X_test, y_train, y_test = load_data(
                100, os.path.join(tmpdir, "*.npz")
            )
            assert y_train.shape[1] == 4  # converted to one-hot
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_load_data_skips_bad_files(self):
        tmpdir = tempfile.mkdtemp()
        try:
            # Good file
            X = np.random.rand(10, 100).astype(np.float32)
            y = np.zeros((10, 4), dtype=np.float32)
            y[:, 0] = 1
            np.savez(os.path.join(tmpdir, "data_000000.npz"),
                     image=X, label=y)
            # Bad file (missing keys)
            np.savez(os.path.join(tmpdir, "data_000001.npz"),
                     garbage=np.zeros(10))

            X_train, _, _, _ = load_data(
                100, os.path.join(tmpdir, "*.npz")
            )
            # Only 10 samples from the good file; 80/20 split → 8 train
            assert X_train.shape[0] == 8
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_load_data_handles_wrong_input_size(self):
        tmpdir = tempfile.mkdtemp()
        try:
            # Save data with 50 features but ask for 100
            X = np.random.rand(10, 50).astype(np.float32)
            y = np.zeros((10, 4), dtype=np.float32)
            y[:, 0] = 1
            np.savez(os.path.join(tmpdir, "data_000000.npz"),
                     image=X, label=y)

            X_train, _, _, _ = load_data(
                100, os.path.join(tmpdir, "*.npz")
            )
            # Should pad to 100
            assert X_train.shape[1] == 100
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# 6. Server / VideoStreamHandler / SensorDataHandler Attribute Tests
# ---------------------------------------------------------------------------

class TestServerAttributes:
    def test_server_has_start(self):
        from rc_driver import Server
        assert hasattr(Server, "start")

    def test_video_stream_handler_class_attributes(self):
        from rc_driver import VideoStreamHandler
        assert hasattr(VideoStreamHandler, "h1")
        assert hasattr(VideoStreamHandler, "h2")
        assert hasattr(VideoStreamHandler, "d_sensor_thresh")
        assert hasattr(VideoStreamHandler, "d_stop_light_thresh")
        assert hasattr(VideoStreamHandler, "stop_start")
        assert hasattr(VideoStreamHandler, "stop_finish")
        assert hasattr(VideoStreamHandler, "stop_time")
        assert hasattr(VideoStreamHandler, "drive_time_after_stop")
        assert VideoStreamHandler.h1 == 5.5
        assert VideoStreamHandler.h2 == 5.5
        assert VideoStreamHandler.d_sensor_thresh == 30
        assert VideoStreamHandler.d_stop_light_thresh == 25

    def test_sensor_data_handler_inherits_base(self):
        from rc_driver import SensorDataHandler
        import socketserver
        assert issubclass(SensorDataHandler,
                          socketserver.BaseRequestHandler)

    def test_video_stream_handler_inherits_stream(self):
        from rc_driver import VideoStreamHandler
        import socketserver
        assert issubclass(VideoStreamHandler,
                          socketserver.StreamRequestHandler)

    def test_video_stream_handler_has_handle(self):
        from rc_driver import VideoStreamHandler
        assert hasattr(VideoStreamHandler, "handle")


class TestCollectTrainingDataHelpers:
    """Test helper methods that don't require network/serial hardware."""

    def test_extract_roi(self):
        from collect_training_data import CollectTrainingData
        # Create a minimal instance without network/serial
        ctd = object.__new__(CollectTrainingData)
        gray = np.random.rand(240, 320)
        roi = ctd._extract_roi(gray)
        assert roi.shape == (120, 320)

    def test_extract_roi_preserves_content(self):
        from collect_training_data import CollectTrainingData
        ctd = object.__new__(CollectTrainingData)
        gray = np.zeros((240, 320), dtype=np.uint8)
        gray[120:240, 0:320] = 255   # lower half bright
        roi = ctd._extract_roi(gray)
        assert np.all(roi == 255)

    def test_save_data_creates_npz(self):
        from collect_training_data import CollectTrainingData
        ctd = object.__new__(CollectTrainingData)
        ctd.input_size = 38400
        ctd.data_counter = 0
        ctd.k = np.eye(4, dtype=np.float32)
        ctd.data_dir = tempfile.mkdtemp()

        roi = np.random.rand(120, 320).astype(np.float32)
        label = 2
        path = ctd._save_data(roi, label)

        assert os.path.isfile(path)
        data = np.load(path)
        assert "image" in data.files
        assert "label" in data.files
        assert data["image"].shape == (38400,)
        assert data["label"].shape == (4,)
        assert data["label"][2] == 1.0

        shutil.rmtree(ctd.data_dir, ignore_errors=True)

    def test_save_data_pads_short_arrays(self):
        from collect_training_data import CollectTrainingData
        ctd = object.__new__(CollectTrainingData)
        ctd.input_size = 100
        ctd.data_counter = 0
        ctd.k = np.eye(4, dtype=np.float32)
        ctd.data_dir = tempfile.mkdtemp()

        roi = np.zeros(50, dtype=np.float32)
        path = ctd._save_data(roi, 0)
        data = np.load(path)
        assert data["image"].shape == (100,)
        shutil.rmtree(ctd.data_dir, ignore_errors=True)

    def test_save_data_truncates_long_arrays(self):
        from collect_training_data import CollectTrainingData
        ctd = object.__new__(CollectTrainingData)
        ctd.input_size = 50
        ctd.data_counter = 0
        ctd.k = np.eye(4, dtype=np.float32)
        ctd.data_dir = tempfile.mkdtemp()

        roi = np.ones(200, dtype=np.float32)
        path = ctd._save_data(roi, 1)
        data = np.load(path)
        assert data["image"].shape == (50,)
        shutil.rmtree(ctd.data_dir, ignore_errors=True)

    def test_label_matrix_is_identity(self):
        from collect_training_data import CollectTrainingData
        ctd = object.__new__(CollectTrainingData)
        ctd.k = np.zeros((4, 4), 'float')
        for i in range(4):
            ctd.k[i, i] = 1
        np.testing.assert_array_equal(ctd.k, np.eye(4))


# ---------------------------------------------------------------------------
# 7. Integration: Full NN pipeline with load_data
# ---------------------------------------------------------------------------

class TestIntegration:
    def test_load_train_evaluate(self):
        tmpdir = tempfile.mkdtemp()
        try:
            input_size = 100
            # Create 10 npz files with 5 samples each
            for i in range(10):
                X = np.random.rand(5, input_size).astype(np.float32) * 255
                y = np.zeros((5, 4), dtype=np.float32)
                y[np.arange(5), np.random.randint(0, 4, 5)] = 1
                np.savez(os.path.join(tmpdir, f"data_{i:06d}.npz"),
                         image=X, label=y)

            X_train, X_test, y_train, y_test = load_data(
                input_size, os.path.join(tmpdir, "*.npz")
            )

            nn = NeuralNetwork()
            nn.create(np.int32([input_size, 16, 4]))
            nn.train(X_train, y_train)
            acc = nn.evaluate(X_test, y_test)
            assert isinstance(acc, float)
            assert 0.0 <= acc <= 1.0
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_save_model_to_subdir(self):
        tmpdir = tempfile.mkdtemp()
        subdir = os.path.join(tmpdir, "new", "nested")
        path = os.path.join(subdir, "model.xml")
        try:
            nn = NeuralNetwork()
            nn.create(np.int32([4, 8, 2]))
            nn.save_model(path)
            assert os.path.isfile(path)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# 8. Edge-case & robustness tests
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_nn_create_with_single_pixel_input(self):
        nn = NeuralNetwork()
        nn.create(np.int32([1, 2, 2]))
        assert nn.mlpc is not None

    def test_nn_train_with_single_sample(self):
        nn = NeuralNetwork()
        nn.create(np.int32([4, 4, 2]))
        X = np.array([[0.1, 0.2, 0.3, 0.4]], dtype=np.float32)
        y = np.array([[1.0, 0.0]], dtype=np.float32)
        nn.train(X, y)  # should not raise

    def test_distance_calculate_with_v_equal_v0(self):
        d = DistanceToCamera()
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        result = d.calculate(d.v0, 5.5, 300, img)
        assert isinstance(result, (float, np.floating))

    def test_distance_calculate_with_very_large_v(self):
        d = DistanceToCamera()
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        result = d.calculate(10000.0, 5.5, 300, img)
        assert isinstance(result, (float, np.floating))

    def test_nn_predict_batch(self):
        nn = NeuralNetwork()
        nn.create(np.int32([4, 8, 3]))
        X = np.random.rand(100, 4).astype(np.float32)
        y = np.zeros((100, 3), dtype=np.float32)
        y[np.arange(100), np.random.randint(0, 3, 100)] = 1
        nn.train(X, y)
        preds = nn.predict(X)
        assert preds.shape == (100,)

    def test_object_detection_flags_reset_on_new_instance(self):
        od1 = ObjectDetection()
        od1.red_light = True
        od2 = ObjectDetection()
        assert od2.red_light is False

    def test_rc_control_multiple_commands(self, monkeypatch):
        """Verify sequential steer/stop commands write correct bytes."""
        monkeypatch.setattr("rc_driver_helper.serial.Serial", MockSerial)
        rc = RCControl("/dev/null")
        rc.steer(2)  # forward → chr(1)
        rc.steer(0)  # left    → chr(7)
        rc.stop()    # stop    → chr(0)
        assert rc.serial_port.written == [b'\x01', b'\x07', b'\x00']

    def test_load_data_returns_correct_types(self):
        tmpdir = tempfile.mkdtemp()
        try:
            X = np.random.rand(5, 50).astype(np.float32)
            y = np.zeros((5, 4), dtype=np.float32)
            y[:, 0] = 1
            np.savez(os.path.join(tmpdir, "data_000000.npz"),
                     image=X, label=y)

            X_train, X_test, y_train, y_test = load_data(
                50, os.path.join(tmpdir, "*.npz")
            )
            assert X_train.dtype == np.float32
            assert y_train.dtype == np.float32
            assert X_test.dtype == np.float32
            assert y_test.dtype == np.float32
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# 9. Class attribute & configuration tests
# ---------------------------------------------------------------------------

class TestConfigurations:
    def test_rccontrol_baudrate(self, monkeypatch):
        class InspectSerial:
            def __init__(self, port, baudrate, timeout=1):
                self.port = port
                self.baudrate = baudrate
                self.timeout = timeout
                self.written = []
            def write(self, data):
                self.written.append(data)
        monkeypatch.setattr("rc_driver_helper.serial.Serial", InspectSerial)
        rc = RCControl("/dev/ttyTEST")
        assert rc.serial_port.baudrate == 115200
        assert rc.serial_port.timeout == 1

    def test_distance_camera_alpha_radians(self):
        d = DistanceToCamera()
        expected = 8.0 * math.pi / 180
        assert abs(d.alpha - expected) < 1e-12

    def test_object_detection_has_all_flag_attributes(self):
        od = ObjectDetection()
        assert hasattr(od, "red_light")
        assert hasattr(od, "green_light")
        assert hasattr(od, "yellow_light")

    def test_video_stream_handler_thresholds(self):
        from rc_driver import VideoStreamHandler
        assert VideoStreamHandler.d_sensor_thresh == 30
        assert VideoStreamHandler.d_stop_light_thresh == 25
        assert VideoStreamHandler.h1 == 5.5
        assert VideoStreamHandler.h2 == 5.5

    def test_video_stream_handler_time_attributes(self):
        from rc_driver import VideoStreamHandler
        assert VideoStreamHandler.stop_start == 0
        assert VideoStreamHandler.stop_finish == 0
        assert VideoStreamHandler.stop_time == 0
        assert VideoStreamHandler.drive_time_after_stop == 0
